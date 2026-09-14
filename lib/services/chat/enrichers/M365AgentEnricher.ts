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
 * default); the query is reformulated with the shared utility model and
 * embedded with the agent's embedding deployment inside searchM365Agent.
 */
import { searchM365Agent } from '@/lib/services/m365/agentIndexService';
import { getAzureMonitorLogger } from '@/lib/services/observability';

import { buildAgentPromptSections } from '@/lib/utils/app/systemPrompt';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { Message, MessageType } from '@/types/chat';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import OpenAI from 'openai';

const REFORMULATION_MODEL = 'gpt-5-mini';

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

export class M365AgentEnricher extends BasePipelineStage {
  readonly name = 'M365AgentEnricher';

  constructor(private openAIClient: OpenAI) {
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
    return this.degradedContext(context, 'timeout');
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

  /** Last user-message text; empty string when none (e.g. image-only). */
  private extractQuery(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      if (typeof message.content === 'string') return message.content;
      return '';
    }
    return '';
  }

  /**
   * Compact search-query reformulation with the shared utility model —
   * same role (and same deployment) as RAGService.reformulateQuery. Any
   * failure falls back to the raw query; retrieval quality degrades, the
   * request never does.
   */
  private async reformulateQuery(messages: Message[]): Promise<string> {
    const original = this.extractQuery(messages);
    if (!original) return original;
    try {
      const history = messages
        .slice(-5)
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : '[non-text]'}`,
        )
        .join('\n');
      const completion = await this.openAIClient.chat.completions.create({
        // No temperature: the gpt-5 family rejects non-default values and
        // the call would silently fall back to the raw query.
        model: REFORMULATION_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Rewrite the final user question as a concise, self-contained search query for a document knowledge base. Resolve pronouns and references using the conversation. Return ONLY the query.',
          },
          { role: 'user', content: `${history}\n\nSearch query:` },
        ],
      });
      return completion.choices[0]?.message?.content?.trim() || original;
    } catch {
      return original;
    }
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
      return this.degradedContext(context, 'no-accessible-sources');
    }

    await context.emitActivity?.('chat.activity.searchingKnowledge');

    const baseMessages = context.enrichedMessages || context.messages;
    let enrichedMessages: Message[] = [...baseMessages];

    try {
      const query = await this.reformulateQuery(context.messages);
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
              "  Include one entry for EVERY source number you cited. Each passage must be copied character-for-character from that source's Content (quotes are rejected if they do not match exactly), must be the passage most relevant to YOUR claims, and should be under 60 words. Output nothing after the block.\n\n" +
              `Available sources:\n\n${contextString}`,
            messageType: MessageType.TEXT,
          },
          ...enrichedMessages,
        ];
      }

      const citations = searchDocs.map((doc, index) => ({
        title: doc.title,
        date: doc.date,
        url: doc.url,
        number: index + 1,
        ...(doc.locator ? { locator: doc.locator } : {}),
        ...(doc.quote ? { quote: doc.quote } : {}),
      }));

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

      return {
        ...context,
        enrichedMessages,
        systemPrompt: this.agentSystemPrompt(context),
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
      return this.degradedContext(context, 'error');
    }
  }
}
