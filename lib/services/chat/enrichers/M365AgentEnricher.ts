/**
 * Retrieval stage for M365 file-backed agents
 * (docs/M365_SECOND_PASS_AGENTS_DESIGN.md) — the RAGEnricher shape over the
 * shared m365-agents index instead of the org index.
 *
 * The two-layer access guard has ALREADY run in the credential middleware by
 * the time this stage executes: `context.m365Agent` is only set for allowed
 * users, and `context.m365AccessibleSourceIds` holds the layer-2-verified
 * subset. This stage never widens either — retrieval is hard-filtered to
 * the accessible sources, so a user sees answers only from files their own
 * Graph token can open.
 *
 * Model orchestration per request: the chat model was resolved by
 * createModelSelectionMiddleware (agent's chatModelId or the catalog
 * default); the query is reformulated under the user's residency (see
 * lib/services/search/queryReformulation.ts) and embedded with the agent's
 * embedding deployment inside searchM365Agent.
 */
import { searchM365Agent } from '@/lib/services/m365/agentIndexService';
import { getAzureMonitorLogger } from '@/lib/services/observability';
import {
  type QueryReformulationPrompt,
  type QueryReformulator,
  latestUserQuestion,
  rewriteConversationHistory,
} from '@/lib/services/search/queryReformulation';

import { buildAgentPromptSections } from '@/lib/utils/app/systemPrompt';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message, MessageType } from '@/types/chat';

import { auxiliaryTurnRouting } from '../auxiliaryTurnRouting';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import { noWebSearchReminder, withOrigin } from '../routing/sourceProvenance';
import type { TextCompletionProvider } from '../textCompletion';
import { prependContextToMessage } from './messageContext';
import { searchRequested } from './searchRequest';

import { emitToolCallRecord } from '@/lib/streamMarkers';

const M365_REFORMULATION_SYSTEM_PROMPT =
  'Rewrite the final user question as a concise, self-contained search query for a document knowledge base. Resolve pronouns and references using the conversation. Return ONLY the query.';

/**
 * Injected in place of the sources block when retrieval could not run. The
 * agent's own prompt is still applied, so the model keeps its persona but
 * is told the truth about its knowledge base — without this note a plain
 * model answers "I don't have any documents", which reads as "the agent has
 * no knowledge" to the user (the exact symptom of a broken index).
 */
const RETRIEVAL_FAILED_NOTE =
  'IMPORTANT: The knowledge-base search for this agent FAILED for this message (a temporary technical error, not a permissions issue and not an empty knowledge base). ' +
  "Tell the user briefly that you could not search the agent's documents right now and ask them to try again in a moment. " +
  'Do NOT claim you have no documents and do NOT answer from general knowledge as if it came from the documents.';

/**
 * Added to the agent's source rules on turns where no web search can run
 * (the owner left web search off, or the user switched search off). An
 * agent whose instructions mention looking things up would otherwise fill
 * the gap from memory and attribute it to a website it never opened.
 */
const NO_WEB_SEARCH_RULE =
  "- No web search is run for this message: the agent's documents are your only source. Never state or imply that something was looked up online or comes from a website or an outside organisation, and give no links to outside sites. " +
  'If you add anything from general knowledge, label it plainly as general knowledge that was not checked against any source and may be out of date.';

/** Tells the model its document search came back empty, so it says so. */
const NO_PASSAGES_NOTE =
  "The search of this agent's documents returned no passages for this message. Say that the documents do not cover it; never present other information as coming from the documents.";

export class M365AgentEnricher extends BasePipelineStage {
  readonly name = 'M365AgentEnricher';

  /**
   * @param reformulator - Rewrites search queries under the user's residency.
   * @param textCompletionProvider - The user's chat model, the rewrite's
   *        fallback when no residency-eligible auxiliary model answers.
   */
  constructor(
    private readonly reformulator: QueryReformulator,
    private readonly textCompletionProvider?: TextCompletionProvider,
  ) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    return !!context.m365Agent;
  }

  /**
   * Pipeline hook: the stage exceeded its budget and the pipeline is about
   * to continue with the PRE-stage context. Degrade explicitly instead of
   * silently handing the user a plain model.
   */
  onTimeout(context: ChatContext): ChatContext {
    const agent = context.m365Agent;
    if (!agent) return context;
    console.error(
      `[M365AgentEnricher] retrieval timed out for ${sanitizeForLog(agent.id)}; degrading with retrieval-failed note`,
    );
    void this.emitKnowledgeSearchRecord(context, {
      error: "The search of the agent's documents timed out.",
    });
    return this.degradedContext(context, 'timeout');
  }

  /** Distinguishes records of the same millisecond. */
  private static knowledgeRecordSeq = 0;

  /**
   * Persistent record of the search of the agent's own documents, in the
   * same "Used N tools" strip as the web search's record — so a reader can
   * see how every source of an answer was found, and that a search which
   * found nothing (or failed) did run.
   *
   * @param context - The turn; needs `emitMarker` and `m365Agent`.
   * @param outcome - The reworded query and what it matched, or the error.
   */
  private async emitKnowledgeSearchRecord(
    context: ChatContext,
    outcome: {
      query?: string;
      passages?: number;
      documents?: number;
      error?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    const agent = context.m365Agent;
    if (!context.emitMarker || !agent) return;
    const { passages = 0, documents = 0 } = outcome;
    const found =
      passages === 0
        ? "No matching passages in the agent's documents"
        : `${passages} passage${passages === 1 ? '' : 's'} from ${documents} document${documents === 1 ? '' : 's'} of the agent`;
    M365AgentEnricher.knowledgeRecordSeq += 1;
    await context.emitMarker(
      emitToolCallRecord({
        id: `knowledge-search-${Date.now()}-${M365AgentEnricher.knowledgeRecordSeq}`,
        name: 'knowledge_search',
        server_label: agent.name,
        arguments: JSON.stringify(
          outcome.query ? { query: outcome.query.slice(0, 500) } : {},
        ),
        status: outcome.error ? 'failed' : 'completed',
        output: outcome.error ? null : found,
        error: outcome.error ?? null,
        ...(outcome.durationMs !== undefined
          ? { duration_ms: outcome.durationMs }
          : {}),
      }),
    );
  }

  /** The agent's prompt with the renderer/summary/memory sections re-appended. */
  private agentSystemPrompt(context: ChatContext): string {
    const agent = context.m365Agent;
    if (!agent?.systemPrompt) return context.systemPrompt;
    // The agent's prompt REPLACES the base prompt, taking the renderer
    // contract (math/markdown/diagram rules) and the summary/memories
    // sections with it. Re-append both, agent instructions first so an
    // agent that overrides formatting still wins on substance
    // (mirrors RAGEnricher).
    const agentSections = buildAgentPromptSections(
      context.conversationSummary,
      context.memories,
    );
    return `${agent.systemPrompt}\n\n${agentSections}`;
  }

  /**
   * Context for a request whose retrieval did not happen: persona applied,
   * an explicit retrieval-failed note ahead of the conversation, and a
   * `retrievalFailed` flag on the agent metadata so telemetry and any
   * client badge can tell "no results" from "search broke".
   */
  private degradedContext(
    context: ChatContext,
    cause: 'error' | 'timeout' | 'no-accessible-sources',
  ): ChatContext {
    const agent = context.m365Agent!;
    const baseMessages = context.enrichedMessages || context.messages;
    return {
      ...context,
      enrichedMessages: [
        {
          role: 'system',
          content: RETRIEVAL_FAILED_NOTE,
          messageType: MessageType.TEXT,
        },
        ...baseMessages,
      ],
      systemPrompt: this.agentSystemPrompt(context),
      // A search that could not run says nothing about what the documents
      // hold; the router must not read it as "not found, fall back".
      agentKnowledge: { status: 'failed', passages: [] },
      processedContent: {
        ...context.processedContent,
        metadata: {
          ...context.processedContent?.metadata,
          m365AgentConfig: {
            agentId: agent.id,
            agentName: agent.name,
            accessibleSources: context.m365AccessibleSourceIds?.length ?? 0,
            totalSources: agent.sources.length,
            resultCount: 0,
            retrievalFailed: true,
            retrievalFailureCause: cause,
          },
        },
      },
    };
  }

  /**
   * Compact search-query reformulation under the user's residency. Any
   * failure falls back to the raw query; retrieval quality degrades, the
   * request never does.
   */
  private async reformulateQuery(context: ChatContext): Promise<string> {
    const messages = context.messages;
    const original = latestUserQuestion(messages);
    if (!original) return original;
    const history = rewriteConversationHistory(messages);
    const prompt: QueryReformulationPrompt = {
      systemPrompt: M365_REFORMULATION_SYSTEM_PROMPT,
      userPrompt: `${history}\n\nSearch query:`,
    };
    const result = await this.reformulator.reformulate(
      prompt,
      auxiliaryTurnRouting(context, this.textCompletionProvider),
    );
    return result?.query ?? original;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const agent = context.m365Agent;
    if (!agent) return context;
    const accessibleSourceIds = context.m365AccessibleSourceIds ?? [];
    if (accessibleSourceIds.length === 0) {
      // Middleware rejects zero-access requests; an empty list here means a
      // wiring regression. Fail safe: no retrieval, no content exposure.
      console.error(
        `[M365AgentEnricher] no accessible sources on context for ${sanitizeForLog(agent.id)}; skipping retrieval`,
      );
      await this.emitKnowledgeSearchRecord(context, {
        error: "None of the agent's documents could be opened for this search.",
      });
      return this.degradedContext(context, 'no-accessible-sources');
    }

    await context.emitActivity?.('chat.activity.searchingKnowledge');

    const baseMessages = context.enrichedMessages || context.messages;
    let enrichedMessages: Message[] = [...baseMessages];

    // Same gate the tool router acts on, so the model is never told a
    // search cannot run on a turn where one then does (or the reverse).
    const webSearchPossible = searchRequested(context);
    const startedAt = Date.now();
    try {
      const query = await this.reformulateQuery(context);
      const searchDocs = query
        ? await searchM365Agent(
            query,
            agent,
            accessibleSourceIds,
            context.m365AccessibleFolderItems ?? [],
          )
        : [];

      if (searchDocs.length > 0) {
        const contextString = searchDocs
          .map((doc, index) => {
            const sourceNumber = index + 1;
            const date = doc.date
              ? new Date(doc.date).toISOString().split('T')[0]
              : '';
            const location = doc.locator ? `\nLocation: ${doc.locator}` : '';
            return `Source ${sourceNumber}:\nTitle: ${doc.title}\nDate: ${date}${location}\nURL: ${doc.url}\nContent: ${doc.chunk}`;
          })
          .join('\n\n');

        enrichedMessages = [
          {
            role: 'system',
            // Trust posture (Wikipedia model): the prose is the model's own
            // words; the EVIDENCE — verbatim quote, source, page — travels
            // on each [n] citation, which the UI renders as a footnote
            // popover. So the text stays readable while every claim stays
            // checkable against the original document.
            content:
              'You have access to the following knowledge base sources. Follow these rules:\n' +
              '- Write naturally in your own words. Cite a source number in SEPARATE brackets after each claim it supports, like [1][2] - never group them like [1,2]. Readers see the supporting passage when they hover a citation, so cite precisely.\n' +
              '- Quote the source verbatim inline only when the exact wording itself matters (a defined term, a specific entitlement or number). Anything inside double quotation marks must appear word-for-word in the sources.\n' +
              "- When a source has a Location (e.g. a page number), you may point the reader there for the full context (e.g. 'see p. 12 [1]') — especially when summarizing a longer section.\n" +
              '- If the sources do not contain the answer, say so — do not fill gaps from general knowledge without flagging it.\n' +
              '- AFTER your complete answer, output a citation-quotes block in EXACTLY this format (it is machine-parsed and never shown to the reader):\n' +
              '<<<CITATION_QUOTES>>>\n' +
              '{"1": "verbatim passage from source 1 supporting the claim(s) you cited it for", "3": "..."}\n' +
              '<<<END_CITATION_QUOTES>>>\n' +
              "  Include one entry for EVERY source number you cited. Each passage must be copied character-for-character from that source's Content (quotes are rejected if they do not match exactly), must be the passage most relevant to YOUR claims, and should be under 60 words. Output nothing after the block.\n" +
              (webSearchPossible ? '' : `${NO_WEB_SEARCH_RULE}\n`) +
              `\nAvailable sources:\n\n${contextString}`,
            messageType: MessageType.TEXT,
          },
          ...enrichedMessages,
        ];
      } else if (query) {
        enrichedMessages = [
          {
            role: 'system',
            content: webSearchPossible
              ? NO_PASSAGES_NOTE
              : `${NO_PASSAGES_NOTE}\n${NO_WEB_SEARCH_RULE}`,
            messageType: MessageType.TEXT,
          },
          ...enrichedMessages,
        ];
      }

      const citations = withOrigin(
        searchDocs.map((doc, index) => ({
          title: doc.title,
          date: doc.date,
          url: doc.url,
          number: index + 1,
          ...(doc.locator ? { locator: doc.locator } : {}),
          ...(doc.quote ? { quote: doc.quote } : {}),
        })),
        'knowledge',
      );

      await this.emitKnowledgeSearchRecord(context, {
        query,
        passages: searchDocs.length,
        documents: new Set(searchDocs.map((doc) => doc.url || doc.title)).size,
        durationMs: Date.now() - startedAt,
      });

      // Verification corpus for the model's claim quotes: chunk text per
      // citation number. StandardChatHandler ships it in a terminal
      // metadata block; the client verifies and DISCARDS it (transient).
      const citationQuoteSources = Object.fromEntries(
        searchDocs.map((doc, index) => [String(index + 1), doc.chunk]),
      );

      // Same visibility RAGEnricher gives static agents: one Search row per
      // retrieval (query omitted for privacy).
      void getAzureMonitorLogger().logSearch({
        user: context.user,
        query: '',
        resultCount: searchDocs.length,
        searchType: 'm365-agent',
        indexName: agent.id,
        botId: context.botId,
        telemetry: context.telemetry,
      });

      // With the web closed for this turn nothing downstream adds the
      // reminder, so it is placed next to the user's message here; when a
      // search may run, the tool router adds it if none does.
      const lastMessage = enrichedMessages[enrichedMessages.length - 1];
      if (!webSearchPossible && lastMessage?.role === 'user') {
        enrichedMessages = [
          ...enrichedMessages.slice(0, -1),
          prependContextToMessage(lastMessage, noWebSearchReminder(citations)),
        ];
      }

      return {
        ...context,
        enrichedMessages,
        systemPrompt: this.agentSystemPrompt(context),
        // The router decides an owner's "otherwise search the web" rule
        // from these passages (agentSearchGuidance.ts).
        agentKnowledge: {
          status: 'searched',
          passages: searchDocs.map((doc) => ({
            title: doc.title,
            text: doc.chunk,
          })),
        },
        processedContent: {
          ...context.processedContent,
          metadata: {
            ...context.processedContent?.metadata,
            citations,
            citationQuoteSources,
            m365AgentConfig: {
              agentId: agent.id,
              agentName: agent.name,
              accessibleSources: accessibleSourceIds.length,
              totalSources: agent.sources.length,
              resultCount: searchDocs.length,
            },
          },
        },
      };
    } catch (error) {
      // Graceful degrade like RAGEnricher — the request never fails — but
      // NOT silently: the persona still applies and the model is told the
      // search broke (see RETRIEVAL_FAILED_NOTE). A live activity line
      // gives the user the same hint while the answer streams.
      console.error(
        `[M365AgentEnricher] retrieval failed for ${sanitizeForLog(agent.id)}: ${sanitizeForLog(error)}`,
      );
      void getAzureMonitorLogger().logSearchError({
        user: context.user,
        indexName: agent.id,
        errorCode: 'M365_AGENT_RETRIEVAL_FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        botId: context.botId,
        telemetry: context.telemetry,
      });
      await context.emitActivity?.('chat.activity.knowledgeSearchFailed');
      await this.emitKnowledgeSearchRecord(context, {
        error:
          "The agent's documents could not be searched (a temporary technical error).",
        durationMs: Date.now() - startedAt,
      });
      return this.degradedContext(context, 'error');
    }
  }
}
