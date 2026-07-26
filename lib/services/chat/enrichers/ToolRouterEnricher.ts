import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { consumeToolBudget } from '@/lib/services/limits/toolBudget';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { getContentType } from '@/lib/utils/server/file/mimeTypes';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  ToolRouterResponse,
} from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { Citation } from '@/types/rag';
import { SearchMode } from '@/types/searchMode';
import {
  MAX_SEARCH_RESULT_COUNT,
  PrecomputedSearchResults,
  sanitizeWebSearchOptions,
} from '@/types/webSearch';

import { AgentChatService } from '../AgentChatService';
import { ToolRouterService } from '../ToolRouterService';
import { ChatContext, shouldExecuteAsAgent } from '../pipeline/ChatContext';
import { STAGE_TIMEOUTS } from '../pipeline/ChatPipeline';
import { BasePipelineStage } from '../pipeline/PipelineStage';
import {
  CodeInterpreterInputFile,
  CodeInterpreterResult,
  CodeInterpreterTool,
} from '../tools/CodeInterpreterTool';
import { WebSearchTool } from '../tools/WebSearchTool';
import { readCitedSources } from '../tools/citedSourceReader';
import { buildNewsResult } from '../tools/newsSearch';

import { env } from '@/config/environment';
import { getOrganizationAgentById } from '@/lib/organizationAgents';
import { emitSearchInterim, emitToolCallRecord } from '@/lib/streamMarkers';

/**
 * ToolRouterEnricher adds intelligent tool routing capabilities.
 *
 * Responsibilities:
 * - Determines if web search / code execution is needed (INTELLIGENT modes)
 * - Forces web search (SearchMode.ALWAYS) and/or code execution
 *   (InterpreterMode.ALWAYS)
 * - Executes search and the code interpreter as tools
 * - Adds tool results to messages; emits the interpreter's TOOL_CALL_RECORD
 *   (code + output + generated files) onto the response stream
 *
 * Modifies context:
 * - context.enrichedMessages (adds tool results)
 *
 * Note: This enricher runs AFTER content processing, so it can work with:
 * - Raw text queries
 * - Queries about uploaded files
 * - Queries about images
 * - Queries about transcribed audio
 */
export class ToolRouterEnricher extends BasePipelineStage {
  readonly name = 'ToolRouterEnricher';

  // Fail-fast budget for the search round-trip. The user sees NO answer
  // tokens until pre-routing finishes, so a slow search stalls the whole
  // answer. Env-tunable (WEB_SEARCH_TIMEOUT_MS, default 120s — Foundry
  // search agent runs typically need 35-90s); on timeout the turn degrades
  // to a knowledge answer with an honest notice instead of blocking for
  // the full stage budget.
  private static readonly SEARCH_TIMEOUT_MS = env.WEB_SEARCH_TIMEOUT_MS;

  // Code execution legitimately runs long (package imports, real data
  // crunching) — keep a generous budget, just under the stage timeout so
  // failures degrade via our catch instead of being killed silently.
  private static readonly INTERPRETER_TIMEOUT_MS =
    STAGE_TIMEOUTS.ToolRouterEnricher - 5000;

  // "Executed by" label on the search tool record for feed-based providers
  // (the Bing and combined paths show the agent model id instead).
  private static readonly FEED_PROVIDER_LABELS: Partial<
    Record<typeof env.WEB_SEARCH_PROVIDER, string>
  > = {
    news: 'GDELT + Google News',
    gdelt: 'GDELT',
    'google-news': 'Google News',
  };

  private toolRouterService: ToolRouterService;
  private webSearchTool: WebSearchTool;
  private codeInterpreterTool: CodeInterpreterTool;

  constructor(
    toolRouterService: ToolRouterService,
    agentChatService: AgentChatService,
  ) {
    super();
    this.toolRouterService = toolRouterService;
    this.webSearchTool = new WebSearchTool(agentChatService);
    this.codeInterpreterTool = new CodeInterpreterTool();
  }

  /**
   * Whether web search is requested for this turn (mode + org-agent gate).
   * Prompt agents also arrive via botId but ride the standard execution
   * path — tools must behave exactly as for a plain model, so they take the
   * standard mode check instead of the static org-agent gate (mirrors
   * RAGEnricher's `!context.promptAgent` guard).
   */
  private searchRequested(context: ChatContext): boolean {
    const modeActive =
      context.searchMode === SearchMode.INTELLIGENT ||
      context.searchMode === SearchMode.ALWAYS;
    if (!modeActive) return false;
    if (context.botId && !context.promptAgent) {
      const agent = getOrganizationAgentById(context.botId);
      return !!agent?.allowWebSearch;
    }
    return true;
  }

  /**
   * Whether the PICKED model can run code_interpreter natively in-turn on
   * the Responses path (Phase 2). MCP turns are excluded — they execute on
   * chat.completions, which has no server-side tools — and fall back to the
   * sub-tool round-trip like any other incapable configuration.
   */
  private nativeInterpreterCapable(context: ChatContext): boolean {
    return (
      context.model?.supportsCodeInterpreter === true &&
      context.model?.supportsResponsesApi === true &&
      context.model?.sdk === 'azure-openai' &&
      !context.model?.isCustomSourceModel &&
      !context.mcpServers?.length
    );
  }

  /**
   * Whether code execution is requested for this turn (env kill switch +
   * mode + org-agent gate).
   */
  private interpreterRequested(context: ChatContext): boolean {
    if (!env.CODE_INTERPRETER_ENABLED) return false;
    const modeActive =
      context.interpreterMode === InterpreterMode.INTELLIGENT ||
      context.interpreterMode === InterpreterMode.ALWAYS;
    if (!modeActive) return false;
    if (context.botId && !context.promptAgent) {
      const agent = getOrganizationAgentById(context.botId);
      return !!agent?.allowCodeInterpreter;
    }
    return true;
  }

  shouldRun(context: ChatContext): boolean {
    return this.searchRequested(context) || this.interpreterRequested(context);
  }

  /** Typed prompts this long are almost certainly pasted-in material. */
  private static readonly PASTED_CONTENT_MIN_CHARS = 1000;

  /**
   * Whether the user supplied their own source material this turn —
   * uploaded files/images/audio on the current message, processed file
   * content, or a text block large enough that it was clearly pasted, not
   * typed. The router classifier then defaults to NOT searching so web
   * results don't dilute the provided sources; only an explicit in-message
   * search request (or SearchMode.ALWAYS, which never reaches the
   * classifier) overrides that.
   */
  private hasUserProvidedContent(
    context: ChatContext,
    rawUserPrompt: string,
  ): boolean {
    if (context.hasFiles || context.hasImages || context.hasAudio) return true;
    const processed = context.processedContent;
    if (
      processed &&
      ((processed.fileSummaries?.length ?? 0) > 0 ||
        (processed.inlineFiles?.length ?? 0) > 0 ||
        (processed.transcripts?.length ?? 0) > 0)
    ) {
      return true;
    }
    return rawUserPrompt.length >= ToolRouterEnricher.PASTED_CONTENT_MIN_CHARS;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    // Start with current messages (may already be enriched by RAG)
    const baseMessages = context.enrichedMessages || context.messages;

    // Extract the last message text for tool routing decision
    const lastMessage = baseMessages[baseMessages.length - 1];
    let currentMessage = this.extractTextFromContent(lastMessage.content);
    // Capture the raw user prompt before file/transcript context gets
    // merged in below. The router LLM benefits from seeing the enriched
    // context, but a literal web search query should be just what the user
    // typed — pasting a 50-page document as the search query bloats input
    // tokens and confuses the search backend.
    const rawUserPrompt = currentMessage;

    // IMPORTANT: Include processed file summaries and transcripts in the analysis
    // This ensures the tool router can see the full context when deciding if web search is needed
    if (context.processedContent) {
      const additionalContext: string[] = [];

      // Add file summaries
      if (context.processedContent.fileSummaries) {
        const summaries = context.processedContent.fileSummaries
          .map((f) => `[Document summary: ${f.filename}]\n${f.summary}`)
          .join('\n\n');
        additionalContext.push(summaries);
      }

      // Add inline file content
      if (context.processedContent.inlineFiles) {
        const inlineText = context.processedContent.inlineFiles
          .map((f) => `[File: ${f.filename}]\n${f.content}`)
          .join('\n\n');
        additionalContext.push(inlineText);
      }

      // Add transcripts
      if (context.processedContent.transcripts) {
        const transcripts = context.processedContent.transcripts
          .map((t) => `[Audio/Video: ${t.filename}]\n${t.transcript}`)
          .join('\n\n');
        additionalContext.push(transcripts);
      }

      // Merge with user's message
      if (additionalContext.length > 0) {
        currentMessage = `${currentMessage}\n\n${additionalContext.join('\n\n')}`;
      }
    }

    const searchRequested = this.searchRequested(context);
    const interpreterRequestedAny = this.interpreterRequested(context);

    // Phase 2 routing: a natively-capable picked model runs the tool
    // IN-TURN on the Responses path — no round-trip, no pre-classification
    // (the model itself decides when to execute). The enricher only stages
    // the raw attachment bytes and flags the turn; incapable models keep
    // the Phase 1 sub-tool round-trip below.
    const nativeInterpreter =
      interpreterRequestedAny && this.nativeInterpreterCapable(context);
    if (nativeInterpreter) {
      console.log(
        '[ToolRouterEnricher] Native code interpreter — deferring to the Responses path',
      );
      context = {
        ...context,
        nativeCodeInterpreter: {
          forced: context.interpreterMode === InterpreterMode.ALWAYS,
          inputFiles: await this.collectInterpreterInputFiles(context),
        },
      };
    }
    const interpreterRequested = interpreterRequestedAny && !nativeInterpreter;

    const forceWebSearch =
      searchRequested && context.searchMode === SearchMode.ALWAYS;
    const forceInterpreter =
      interpreterRequested &&
      context.interpreterMode === InterpreterMode.ALWAYS;

    // Skip routing when the chat is going to run as a Foundry agent —
    // agents have their own `web_search_call` tool and decide for themselves
    // when to use it. Pre-routing duplicates work and adds ~5s of latency
    // per request. Forced modes override: the user explicitly asked for the
    // tool this turn. Predicate is shared with AgentEnricher to prevent the
    // two enrichers from drifting apart.
    if (shouldExecuteAsAgent(context) && !forceWebSearch && !forceInterpreter) {
      console.log(
        '[ToolRouterEnricher] Skipping pre-routing — agent will decide via its own tools',
      );
      return context;
    }

    // "Summarize from headlines" resend: the client aborted a combined
    // search mid-Bing and echoed back the interim headlines it already
    // showed. Those ARE the search result for this turn — no router call,
    // no fresh search. A forced interpreter still runs afterwards.
    if (searchRequested && context.precomputedSearchResults?.entries.length) {
      let workingContext = await this.applyPrecomputedSearchResults(
        context,
        context.precomputedSearchResults,
      );
      if (forceInterpreter) {
        workingContext = await this.executeCodeInterpreter(
          workingContext,
          rawUserPrompt,
        );
      }
      return workingContext;
    }

    // Forced tools skip the gpt-5.4-nano router call (saves ~1-2s of
    // latency). The classifier only runs for tools still in INTELLIGENT
    // mode; forced decisions are unioned in afterwards.
    const undecidedSearch = searchRequested && !forceWebSearch;
    const undecidedInterpreter = interpreterRequested && !forceInterpreter;
    // Citations from the most recent searched turn: follow-up questions
    // about that data are answered by re-fetching THOSE articles rather
    // than searching fresh (same sources, full depth).
    const priorCitations = searchRequested
      ? ToolRouterEnricher.latestCitations(baseMessages)
      : [];
    let decided: ToolRouterResponse = { tools: [] };
    if (undecidedSearch || undecidedInterpreter) {
      decided = await this.toolRouterService.determineTool({
        messages: baseMessages,
        currentMessage,
        forceWebSearch: false,
        considerCodeExecution: undecidedInterpreter,
        hasPriorSearchCitations: undecidedSearch && priorCitations.length > 0,
        hasUserProvidedContent:
          undecidedSearch &&
          this.hasUserProvidedContent(context, rawUserPrompt),
      });
    } else {
      console.log(
        '[ToolRouterEnricher] All requested tools forced; skipping router decision',
      );
    }

    const tools = new Set(
      decided.tools.filter(
        (t) =>
          (t === 'web_search' && undecidedSearch) ||
          (t === 'code_interpreter' && undecidedInterpreter),
      ),
    );
    if (forceWebSearch) tools.add('web_search');
    if (forceInterpreter) tools.add('code_interpreter');

    // Use the raw user prompt (no merged file/transcript context) for
    // forced runs so the tool backend gets a clean query/task. The tool's
    // own model can refine it further if needed.
    const toolResponse: ToolRouterResponse = {
      tools: [...tools],
      searchQuery: forceWebSearch ? rawUserPrompt : decided.searchQuery,
      searchQueries: forceWebSearch ? undefined : decided.searchQueries,
      // Dynamic tuning only comes from the classifier; forced searches have
      // no router read and fall back to the user's configured options.
      searchRecency: decided.searchRecency,
      searchComprehensive: decided.searchComprehensive,
      searchFollowUp: decided.searchFollowUp,
      codeTask: forceInterpreter ? rawUserPrompt : decided.codeTask,
    };

    // If no tools needed, return unchanged context. A follow-up on cited
    // sources counts as work even when no fresh search is warranted.
    const followUpRequested =
      toolResponse.searchFollowUp === true && priorCitations.length > 0;
    if (toolResponse.tools.length === 0 && !followUpRequested) {
      return context;
    }

    let workingContext = context;

    // Follow-up on previously cited sources: fetch THOSE articles' content
    // first. When it yields text, it REPLACES a fresh search — the user is
    // asking about data already on the table, and a new search could return
    // entirely different sources.
    let followUpSatisfied = false;
    if (followUpRequested) {
      const { context: followUpContext, fetchedCount } =
        await this.executeCitedSourceFollowUp(workingContext, priorCitations);
      workingContext = followUpContext;
      followUpSatisfied = fetchedCount > 0;
    }

    // Execute web search if needed. Effective tuning = the user's settings
    // (bounded server-side) plus the router's per-message signals: with
    // freshness 'auto' the router's recency read applies, and research-style
    // questions widen the source cap beyond the configured default.
    if (toolResponse.tools.includes('web_search') && !followUpSatisfied) {
      const options = sanitizeWebSearchOptions(context.webSearchOptions);
      // User-selected backend wins; 'auto' defers to the deployment
      // default (WEB_SEARCH_PROVIDER env).
      const provider =
        options.provider === 'auto'
          ? env.WEB_SEARCH_PROVIDER
          : options.provider;
      const freshness =
        options.freshness === 'auto'
          ? (toolResponse.searchRecency ?? 'any')
          : options.freshness;
      const resultCount = toolResponse.searchComprehensive
        ? Math.min(MAX_SEARCH_RESULT_COUNT, Math.max(options.resultCount, 12))
        : options.resultCount;

      workingContext = await this.executeWebSearch(
        workingContext,
        toolResponse.searchQueries?.length
          ? toolResponse.searchQueries
          : [toolResponse.searchQuery || currentMessage],
        {
          resultCount,
          freshness,
          provider,
          // Research-style questions justify waiting on every news feed;
          // single-fact lookups answer from the fastest one.
          deep: toolResponse.searchComprehensive === true,
        },
      );
    }

    // Execute the code interpreter if needed. Runs AFTER search so its
    // merged context (executed results) sits closest to the user's message.
    if (toolResponse.tools.includes('code_interpreter')) {
      workingContext = await this.executeCodeInterpreter(
        workingContext,
        toolResponse.codeTask || rawUserPrompt,
      );
    }

    return workingContext;
  }

  /**
   * Runs the web-search tool and merges results into the last user message.
   * Returns the context unchanged when search is unavailable; on failure
   * merges a failure notice instead so the model levels with the user.
   */
  private async executeWebSearch(
    context: ChatContext,
    searchQueries: string[],
    tuning: {
      resultCount: number;
      freshness: 'day' | 'week' | 'month' | 'any';
      provider:
        | 'news'
        | 'gdelt'
        | 'google-news'
        | 'bing-agent'
        | 'bing-responses'
        | 'combined';
      deep: boolean;
    },
  ): Promise<ChatContext> {
    // Usage limit (docs/LIMITS.md). DEGRADE, DO NOT ABORT: by the time an
    // enricher runs, the streaming Response has already been returned and the
    // HTTP status is committed to 200. Killing the turn because an optional
    // accelerator ran out of budget would surface as an opaque failure AND
    // waste the tokens already spent — so the search is skipped, the user is
    // told, and the model answers from what it has.
    if (!(await consumeToolBudget(context, 'feature.webSearch.callsPerDay'))) {
      await context.emitActivity?.('chat.activity.webSearchLimitReached');
      return context;
    }

    const baseMessages = context.enrichedMessages || context.messages;
    // Primary query drives the Bing path and single-query providers; the
    // full list fans out across parallel Google News legs. Record/notice
    // strings show every query so multi-aspect runs stay legible.
    const searchQuery = searchQueries[0];
    const queryLabel = searchQueries.join(' | ');
    console.log(
      `[ToolRouterEnricher] Executing web search via ${tuning.provider}: "${queryLabel}" (queries: ${searchQueries.length}, sources: ${tuning.resultCount}, freshness: ${tuning.freshness})`,
    );

    const startTime = Date.now();
    // The provider decides what "executed the search" means for the tool
    // record: the agent model for Bing/combined, the feed(s) themselves
    // otherwise.
    const needsAgent =
      tuning.provider === 'bing-agent' || tuning.provider === 'combined';
    const feedLabel = ToolRouterEnricher.FEED_PROVIDER_LABELS[tuning.provider];
    // Bing/combined: find a model with agentId (prefer from context,
    // fallback to the default search agent). Feed providers need neither.
    const searchModel = needsAgent
      ? context.model.agentId
        ? context.model
        : this.getAgentModelForSearch()
      : null;
    const executorLabel =
      tuning.provider === 'bing-responses'
        ? // Direct Responses-API call: no Foundry agent, no feed label.
          `Bing web_search (${env.WEB_SEARCH_RESPONSES_MODEL})`
        : tuning.provider === 'combined'
          ? searchModel
            ? `Bing (${searchModel.id}) + Google News`
            : 'Google News'
          : needsAgent
            ? (searchModel?.id ?? 'unavailable')
            : feedLabel!;
    {
      try {
        if (tuning.provider === 'bing-agent' && !searchModel) {
          console.warn(
            '[ToolRouterEnricher] No agent model available for search, skipping',
          );
          return context;
        }
        if (tuning.provider === 'combined' && !searchModel) {
          // The combined tool degrades to the news feed alone when no
          // agent model exists — worth logging, not worth skipping.
          console.warn(
            '[ToolRouterEnricher] Combined search without an agent model; news feed only',
          );
        }

        // Tell the client what we're doing — showing the ACTUAL query makes
        // the multi-second wait feel purposeful instead of stuck.
        await context.emitActivity?.(
          searchQueries.length > 1
            ? 'chat.activity.searchingWebForMultiple'
            : 'chat.activity.searchingWebFor',
          searchQueries.length > 1
            ? {
                count: String(searchQueries.length),
                query: ToolRouterEnricher.truncate(searchQuery, 40),
              }
            : { query: ToolRouterEnricher.truncate(searchQuery, 60) },
        );

        let searchTimer: ReturnType<typeof setTimeout> | undefined;
        const searchResult = await Promise.race([
          this.webSearchTool.execute({
            searchQuery,
            searchQueries,
            model: searchModel ?? undefined,
            user: context.user,
            resultCount: tuning.resultCount,
            freshness: tuning.freshness,
            provider: tuning.provider,
            deep: tuning.deep,
            // Combined provider: stream the fast leg's headlines to the
            // client while Bing runs — renders the interim list with the
            // "Summarize from headlines" action.
            onInterimResults:
              tuning.provider === 'combined' && context.emitMarker
                ? (entries) => {
                    // Best-effort side channel: a rejected emit (client
                    // gone, stream closed) must neither surface as an
                    // unhandled rejection nor affect the search itself.
                    context.emitMarker!(
                      emitSearchInterim({ queries: searchQueries, entries }),
                    ).catch((error) => {
                      console.warn(
                        '[ToolRouterEnricher] Interim headlines emit failed (ignored):',
                        error instanceof Error ? error.message : error,
                      );
                    });
                  }
                : undefined,
            // Progress phases from inside the sub-call (searching → reading
            // sources → …). The generic searchingWeb key is skipped so it
            // never overwrites the query-specific loader above.
            onActivity: (key, params) => {
              if (key !== 'chat.activity.searchingWeb') {
                void context.emitActivity?.(key, params);
              }
            },
          }),
          new Promise<never>((_, reject) => {
            searchTimer = setTimeout(() => {
              const err = new Error('Web search timed out');
              (err as { isSearchTimeout?: boolean }).isSearchTimeout = true;
              reject(err);
            }, ToolRouterEnricher.SEARCH_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (searchTimer) clearTimeout(searchTimer);
        });

        console.log(
          `[ToolRouterEnricher] Search completed: ${searchResult.text.length} chars, ${searchResult.citations?.length || 0} citations`,
        );
        console.log(
          '[ToolRouterEnricher] Search result citations detail:',
          JSON.stringify(searchResult.citations, null, 2),
        );

        // Zero citations = the search found nothing usable (this branch also
        // catches WebSearchTool's swallowed-error path, which returns an
        // error note with an empty citations array). Merging a "Web Search
        // results" block around nothing makes the model waffle — instead,
        // tell it plainly to answer from knowledge with ONE honest caveat,
        // and record the empty outcome so the user sees why.
        if ((searchResult.citations?.length ?? 0) === 0) {
          console.warn(
            '[ToolRouterEnricher] Search returned no sources; answering from model knowledge',
          );
          await this.emitSearchRecord(
            context,
            queryLabel,
            executorLabel,
            '0 sources found',
            null,
            Date.now() - startTime,
          );

          const emptyNotice =
            `Note: a live web search ran for this request but found no useful sources. ` +
            `Mention that ONCE, briefly. Then answer the user's ACTUAL question confidently from your own knowledge, as specifically as you can. ` +
            `If you do not have specific knowledge of the event or fact being asked about, say so in one sentence and suggest narrowing the question — ` +
            `do NOT pad the answer with generic background, and do not apologize repeatedly or speculate about why the search failed.`;
          const lastMsg = baseMessages[baseMessages.length - 1];
          return {
            ...context,
            enrichedMessages: [
              ...baseMessages.slice(0, -1),
              this.prependContextToMessage(lastMsg, emptyNotice),
            ],
          };
        }

        // Get existing RAG citations to calculate correct numbering
        const existingCitations =
          context.processedContent?.metadata?.citations || [];
        const citationOffset = existingCitations.length;

        // Cap search result text + citation count before synthesis. Without
        // this, a long search summary (10KB+) and a citations array of 20+
        // entries balloon the input prompt — slower synthesis, more cost,
        // and harder for the model to attend to the actual user question.
        // The citation cap is the user's configured source count (router-
        // widened for research questions); the text budget scales with it
        // so deeper searches keep proportionally more summary.
        const MAX_SEARCH_CITATIONS = tuning.resultCount;
        const MAX_SEARCH_TEXT_CHARS = Math.min(
          16000,
          4000 + MAX_SEARCH_CITATIONS * 800,
        );
        const rawSearchText =
          searchResult.text.length > MAX_SEARCH_TEXT_CHARS
            ? searchResult.text.slice(0, MAX_SEARCH_TEXT_CHARS) +
              '\n\n[…search results truncated for length]'
            : searchResult.text;

        // Normalize the sub-tool's citations before numbering, and REMAP
        // every [N] reference in the summary text to the FINAL numbering so
        // the text refs and the source list can never disagree (the failure
        // mode: text citing [1][3][5] while the sources panel showed
        // [2][4][6] phantom pairs from the agent's marker/annotation split):
        //  - drop URL-less label-only entries (unusable as sources)
        //  - dedupe by URL (both duplicate numbers remap to one entry)
        //  - cap at MAX_SEARCH_CITATIONS (refs past the cap are stripped)
        const cleanedCitations: NonNullable<typeof searchResult.citations> = [];
        const renumbering = new Map<number, number>();
        // URL-less entries are inline-marker phantoms whose real source is
        // the NEXT url-bearing entry (the agent emits marker → annotation
        // in pairs) — their numbers remap to that entry so text refs like
        // [1][3][5] resolve instead of being stripped.
        let pendingPhantomNumbers: number[] = [];
        for (const citation of searchResult.citations ?? []) {
          if (!citation.url) {
            pendingPhantomNumbers.push(citation.number);
            continue;
          }
          const existingIdx = cleanedCitations.findIndex(
            (c) => c.url === citation.url,
          );
          let mappedNumber: number | undefined;
          if (existingIdx >= 0) {
            mappedNumber = citationOffset + existingIdx + 1;
          } else if (cleanedCitations.length < MAX_SEARCH_CITATIONS) {
            cleanedCitations.push(citation);
            mappedNumber = citationOffset + cleanedCitations.length;
          }
          // Beyond the cap: no mapping — the references are stripped below
          // (the surrounding sentence still reads correctly without them).
          if (mappedNumber !== undefined) {
            renumbering.set(citation.number, mappedNumber);
            for (const phantom of pendingPhantomNumbers) {
              renumbering.set(phantom, mappedNumber);
            }
          }
          pendingPhantomNumbers = [];
        }
        const truncatedCitations = cleanedCitations;
        const truncatedSearchText = rawSearchText.replace(
          /\[(\d+)\]/g,
          (_match, n) => {
            const mapped = renumbering.get(Number(n));
            return mapped !== undefined ? `[${mapped}]` : '';
          },
        );

        // All citations were URL-less phantoms — same outcome as an empty
        // search: answer from knowledge with one honest caveat.
        if (truncatedCitations.length === 0) {
          console.warn(
            '[ToolRouterEnricher] Search citations were all unusable; answering from model knowledge',
          );
          const emptyNotice =
            `Note: a live web search ran for this request but found no useful sources. ` +
            `Mention that ONCE, briefly. Then answer the user's ACTUAL question confidently from your own knowledge, as specifically as you can — ` +
            `do NOT pad the answer with generic background.`;
          const lastMsgEmpty = baseMessages[baseMessages.length - 1];
          return {
            ...context,
            enrichedMessages: [
              ...baseMessages.slice(0, -1),
              this.prependContextToMessage(lastMsgEmpty, emptyNotice),
            ],
          };
        }

        // Build search context to prepend to the last user message
        // We merge search results INTO the user message instead of using a separate
        // system message, because Anthropic's API only supports 'user' and 'assistant'
        // roles — system messages are stripped by the Anthropic handler.
        // Citation numbers must match the merged citation numbers (RAG first, then web)
        const citationReferences = truncatedCitations.length
          ? truncatedCitations
              .map(
                (c, idx) => `[${citationOffset + idx + 1}] ${c.title || c.url}`,
              )
              .join('\n')
          : '';

        const searchContext = `Web Search results:\n\n${truncatedSearchText}\n\nAvailable sources:\n${citationReferences}\n\nIMPORTANT: When referencing these sources in your response, use citation markers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3]. Do NOT include source information (URLs, titles, or dates) in your response text. The citation details will be displayed separately to the user.`;

        // Merge search context into the last user message so it works with ALL
        // model providers (OpenAI, Anthropic, DeepSeek, Llama, etc.)
        const lastMsg = baseMessages[baseMessages.length - 1];
        const enrichedLastMessage = this.prependContextToMessage(
          lastMsg,
          searchContext,
        );

        const enrichedMessages = [
          ...baseMessages.slice(0, -1),
          enrichedLastMessage,
        ];
        // Use the truncated citation list so the UI citations match the
        // numbered references in `citationReferences` above. Extra citations
        // (beyond the truncation cap) won't have numbered references in the
        // prompt and would render as orphans.
        const newCitations = truncatedCitations;

        const mergedCitations = [
          ...existingCitations,
          ...newCitations.map((c, idx) => ({
            ...c,
            number: existingCitations.length + idx + 1,
          })),
        ];

        console.log(
          '[ToolRouterEnricher] Merging citations - existing:',
          existingCitations.length,
          'new:',
          newCitations.length,
          'total:',
          mergedCitations.length,
        );

        // Persistent record — parity with the code interpreter: users see
        // WHAT was searched, which model ran it, and how long it took, in
        // the same "Used N tools" strip. A combined search whose Bing leg
        // failed says so — the source count alone would overstate coverage.
        const degradedNote = searchResult.metadata?.bingFailed
          ? ' (Bing failed — Google News headlines only)'
          : '';
        await this.emitSearchRecord(
          context,
          queryLabel,
          executorLabel,
          `${truncatedCitations.length} source${truncatedCitations.length === 1 ? '' : 's'} found${degradedNote}`,
          null,
          Date.now() - startTime,
        );

        return {
          ...context,
          enrichedMessages,
          processedContent: {
            ...context.processedContent,
            metadata: {
              ...context.processedContent?.metadata,
              citations: mergedCitations,
            },
          },
        };
      } catch (error) {
        const timedOut =
          (error as { isSearchTimeout?: boolean })?.isSearchTimeout === true;
        console.error(
          `[ToolRouterEnricher] Web search ${timedOut ? 'timed out' : 'failed'}:`,
          error,
        );

        await this.emitSearchRecord(
          context,
          queryLabel,
          executorLabel,
          null,
          timedOut ? 'Web search timed out' : 'Web search failed',
          Date.now() - startTime,
        );

        // Still answer, but tell the model the search didn't return —
        // and forbid the generic-background filler that makes these
        // answers feel valueless.
        const failureNotice =
          `Note: a live web search was attempted for this request but it ${timedOut ? 'timed out' : 'failed'}, so no live results are available. ` +
          `Mention that ONCE, briefly. Then answer the user's ACTUAL question from your knowledge as specifically as you can. ` +
          `If you do not have specific knowledge of the event or fact being asked about, say so in one sentence and suggest retrying the search or narrowing the question — ` +
          `do NOT pad the answer with generic background loosely related to the topic.`;

        const lastMsg = baseMessages[baseMessages.length - 1];
        const enrichedLastMessage = this.prependContextToMessage(
          lastMsg,
          failureNotice,
        );

        return {
          ...context,
          enrichedMessages: [...baseMessages.slice(0, -1), enrichedLastMessage],
        };
      }
    }
  }

  /**
   * Most recent assistant turn's citations — the sources a follow-up
   * question would be referring to.
   */
  private static latestCitations(messages: Message[]): Citation[] {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && (msg.citations?.length ?? 0) > 0) {
        return msg.citations!;
      }
    }
    return [];
  }

  /**
   * Follow-up path: fetch the previously cited articles' full content and
   * merge it into the prompt the same way search results merge — same
   * sources the user already saw, but with real article text instead of
   * headlines. Returns fetchedCount so the caller can decide whether a
   * fresh search is still needed as a fallback.
   */
  private async executeCitedSourceFollowUp(
    context: ChatContext,
    priorCitations: Citation[],
  ): Promise<{ context: ChatContext; fetchedCount: number }> {
    const baseMessages = context.enrichedMessages || context.messages;
    const startTime = Date.now();
    console.log(
      `[ToolRouterEnricher] Follow-up on ${priorCitations.length} previously cited sources`,
    );
    await context.emitActivity?.('chat.activity.readingCitedSources', {
      count: String(Math.min(priorCitations.length, 5)),
    });

    try {
      const digest = await readCitedSources(priorCitations);
      if (digest.fetchedCount === 0) {
        console.warn(
          '[ToolRouterEnricher] No cited articles were readable; falling back',
        );
        await this.emitSearchRecord(
          context,
          'Re-read previously cited articles',
          'Cited sources',
          '0 articles readable',
          null,
          Date.now() - startTime,
        );
        return { context, fetchedCount: 0 };
      }

      const existingCitations =
        context.processedContent?.metadata?.citations || [];
      const citationOffset = existingCitations.length;
      // Digest numbering is local [1..n]; shift it when RAG citations
      // already occupy the low numbers.
      const digestText =
        citationOffset > 0
          ? digest.text.replace(
              /\[(\d+)\]/g,
              (_match, n) => `[${Number(n) + citationOffset}]`,
            )
          : digest.text;

      const references = digest.citations
        .map((c, idx) => `[${citationOffset + idx + 1}] ${c.title || c.url}`)
        .join('\n');
      const followUpBlock = `${digestText}\n\nAvailable sources:\n${references}\n\nIMPORTANT: When referencing these sources in your response, use citation markers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3]. Do NOT include source information (URLs, titles, or dates) in your response text. The citation details will be displayed separately to the user.`;

      const lastMsg = baseMessages[baseMessages.length - 1];
      const enrichedMessages = [
        ...baseMessages.slice(0, -1),
        this.prependContextToMessage(lastMsg, followUpBlock),
      ];
      const mergedCitations = [
        ...existingCitations,
        ...digest.citations.map((c, idx) => ({
          ...c,
          number: citationOffset + idx + 1,
        })),
      ];

      await this.emitSearchRecord(
        context,
        'Re-read previously cited articles',
        'Cited sources',
        `${digest.fetchedCount} of ${digest.attemptedCount} articles read`,
        null,
        Date.now() - startTime,
      );

      return {
        context: {
          ...context,
          enrichedMessages,
          processedContent: {
            ...context.processedContent,
            metadata: {
              ...context.processedContent?.metadata,
              citations: mergedCitations,
            },
          },
        },
        fetchedCount: digest.fetchedCount,
      };
    } catch (error) {
      console.error(
        '[ToolRouterEnricher] Cited-source follow-up failed:',
        error,
      );
      await this.emitSearchRecord(
        context,
        'Re-read previously cited articles',
        'Cited sources',
        null,
        'Article fetch failed',
        Date.now() - startTime,
      );
      return { context, fetchedCount: 0 };
    }
  }

  /**
   * "Summarize from headlines" path: the client echoed back the interim
   * headlines it received during an aborted combined search. Rebuild the
   * digest from those entries and merge it exactly like a fresh search
   * result — no router call, no network. Entries arrived through
   * InputValidator's bounded schema and originally came from our own
   * interim emission.
   */
  private async applyPrecomputedSearchResults(
    context: ChatContext,
    precomputed: PrecomputedSearchResults,
  ): Promise<ChatContext> {
    const baseMessages = context.enrichedMessages || context.messages;
    const startTime = Date.now();
    const options = sanitizeWebSearchOptions(context.webSearchOptions);
    const entries = precomputed.entries.slice(0, options.resultCount);
    const queryLabel = precomputed.queries.join(' | ');
    console.log(
      `[ToolRouterEnricher] Summarizing from ${entries.length} echoed headlines (no fresh search)`,
    );

    const digest = buildNewsResult(
      entries,
      precomputed.queries.map((q) => `"${q}"`).join('; '),
    );

    const existingCitations =
      context.processedContent?.metadata?.citations || [];
    const citationOffset = existingCitations.length;
    // Digest numbering is local [1..n]; shift it when RAG citations
    // already occupy the low numbers. Anchored to line starts — that is
    // where buildNewsResult puts its markers — so bracketed numbers
    // INSIDE headline titles/snippets are never rewritten.
    const digestText =
      citationOffset > 0
        ? digest.text.replace(
            /^\[(\d+)\]/gm,
            (_match, n) => `[${Number(n) + citationOffset}]`,
          )
        : digest.text;

    const references = digest.citations
      .map((c, idx) => `[${citationOffset + idx + 1}] ${c.title || c.url}`)
      .join('\n');
    const searchContext = `Web Search results:\n\n${digestText}\n\nAvailable sources:\n${references}\n\nIMPORTANT: When referencing these sources in your response, use citation markers in SEPARATE brackets like [1][2][3] - never group them like [1,2,3]. Do NOT include source information (URLs, titles, or dates) in your response text. The citation details will be displayed separately to the user.`;

    const lastMsg = baseMessages[baseMessages.length - 1];
    const enrichedMessages = [
      ...baseMessages.slice(0, -1),
      this.prependContextToMessage(lastMsg, searchContext),
    ];
    const mergedCitations = [
      ...existingCitations,
      ...digest.citations.map((c, idx) => ({
        ...c,
        number: citationOffset + idx + 1,
      })),
    ];

    await this.emitSearchRecord(
      context,
      queryLabel,
      'Google News',
      `${digest.citations.length} source${digest.citations.length === 1 ? '' : 's'} from earlier headlines`,
      null,
      Date.now() - startTime,
    );

    return {
      ...context,
      enrichedMessages,
      processedContent: {
        ...context.processedContent,
        metadata: {
          ...context.processedContent?.metadata,
          citations: mergedCitations,
        },
      },
    };
  }

  /**
   * Emits the web search's persistent TOOL_CALL_RECORD (same channel and
   * shape the code interpreter uses). The full result text lives in the
   * merged prompt + citations — the record carries the query and a short
   * outcome so the tool strip stays scannable.
   */
  private async emitSearchRecord(
    context: ChatContext,
    query: string,
    executingModelId: string | undefined,
    outcome: string | null,
    error: string | null,
    durationMs: number,
  ): Promise<void> {
    if (!context.emitMarker) return;

    const MAX_QUERY_CHARS = 500;
    await context.emitMarker(
      emitToolCallRecord({
        id: `web-search-${Date.now()}`,
        name: 'web_search',
        server_label: executingModelId
          ? `Web Search (${executingModelId})`
          : 'Web Search',
        arguments: JSON.stringify({
          query: ToolRouterEnricher.truncate(query, MAX_QUERY_CHARS),
        }),
        status: error ? 'failed' : 'completed',
        output: outcome,
        error,
        duration_ms: durationMs,
      }),
    );
  }

  /**
   * Runs the code interpreter for `task` and merges the executed results
   * into the last user message. Emits a TOOL_CALL_RECORD (code, output,
   * generated files) onto the response stream so the client renders the
   * run below the assistant message. Failures degrade to a merged notice —
   * the chat itself never fails because the sandbox did.
   */
  private async executeCodeInterpreter(
    context: ChatContext,
    task: string,
  ): Promise<ChatContext> {
    // Same degrade-don't-abort contract as web search above.
    if (
      !(await consumeToolBudget(context, 'feature.codeInterpreter.runsPerDay'))
    ) {
      await context.emitActivity?.('chat.activity.codeInterpreterLimitReached');
      return context;
    }

    const baseMessages = context.enrichedMessages || context.messages;
    const startTime = Date.now();
    console.log('[ToolRouterEnricher] Executing code interpreter');

    // Interpreter runs take multiple seconds — keep the loader honest.
    await context.emitActivity?.('chat.activity.runningCode');

    try {
      const inputFiles = await this.collectInterpreterInputFiles(context);

      let interpreterTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.codeInterpreterTool.execute({
          task,
          session: context.session,
          inputFiles,
        }),
        new Promise<never>((_, reject) => {
          interpreterTimer = setTimeout(() => {
            const err = new Error('Code interpreter timed out');
            (err as { isInterpreterTimeout?: boolean }).isInterpreterTimeout =
              true;
            reject(err);
          }, ToolRouterEnricher.INTERPRETER_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (interpreterTimer) clearTimeout(interpreterTimer);
      });

      console.log(
        `[ToolRouterEnricher] Code interpreter completed: ${result.codeRuns.length} runs, ${result.generatedFiles.length} generated files, ${result.text.length} chars`,
      );

      await this.emitInterpreterRecord(
        context,
        result,
        null,
        Date.now() - startTime,
      );

      const lastMsg = baseMessages[baseMessages.length - 1];
      const enrichedLastMessage = this.prependContextToMessage(
        lastMsg,
        this.buildInterpreterContext(result),
      );
      return {
        ...context,
        enrichedMessages: [...baseMessages.slice(0, -1), enrichedLastMessage],
      };
    } catch (error) {
      const timedOut =
        (error as { isInterpreterTimeout?: boolean })?.isInterpreterTimeout ===
        true;
      console.error(
        `[ToolRouterEnricher] Code interpreter ${timedOut ? 'timed out' : 'failed'}:`,
        error,
      );

      await this.emitInterpreterRecord(
        context,
        null,
        timedOut ? 'Code execution timed out' : 'Code execution failed',
        Date.now() - startTime,
      );

      // Still answer, but tell the model the code didn't run.
      const failureNotice =
        `Note: sandboxed code execution was attempted for this request but it ${timedOut ? 'timed out' : 'failed'}, so no executed results are available. ` +
        `Answer as best you can without them and clearly tell the user the code could not be run.`;
      const lastMsg = baseMessages[baseMessages.length - 1];
      const enrichedLastMessage = this.prependContextToMessage(
        lastMsg,
        failureNotice,
      );
      return {
        ...context,
        enrichedMessages: [...baseMessages.slice(0, -1), enrichedLastMessage],
      };
    }
  }

  /**
   * Emits the interpreter's persistent TOOL_CALL_RECORD onto the response
   * stream (same channel the MCP tool loop uses, so the client's existing
   * parser/persistence/rendering applies). No-op when the route didn't
   * install emitMarker (e.g. non-streaming tests).
   */
  private async emitInterpreterRecord(
    context: ChatContext,
    result: CodeInterpreterResult | null,
    error: string | null,
    durationMs: number,
  ): Promise<void> {
    if (!context.emitMarker) return;

    const MAX_CODE_CHARS = 6000;
    const MAX_OUTPUT_CHARS = 4000;
    const code = (result?.codeRuns ?? [])
      .map((r) => r.code)
      .filter(Boolean)
      .join('\n\n# --- next execution ---\n\n');
    const logs = (result?.codeRuns ?? [])
      .map((r) => r.logs)
      .filter(Boolean)
      .join('\n');
    const output = [logs, result?.text].filter(Boolean).join('\n\n');

    await context.emitMarker(
      emitToolCallRecord({
        id: `code-interpreter-${Date.now()}`,
        name: 'code_interpreter',
        // Surface WHICH model executed the code: the round-trip runs on the
        // interpreter sub-tool model, not the conversation's picked model
        // (renders as "via Code Interpreter (gpt-5.2)" in the tool summary).
        server_label: `Code Interpreter (${env.CODE_INTERPRETER_MODEL})`,
        arguments: code
          ? JSON.stringify({
              code: ToolRouterEnricher.truncate(code, MAX_CODE_CHARS),
            })
          : null,
        status: error ? 'failed' : 'completed',
        output: output
          ? ToolRouterEnricher.truncate(output, MAX_OUTPUT_CHARS)
          : null,
        error,
        duration_ms: durationMs,
        ...(result?.generatedFiles?.length
          ? { generated_files: result.generatedFiles }
          : {}),
      }),
    );
  }

  /**
   * Builds the context block merged into the last user message so the
   * PICKED model can answer from the executed results (the round-trip that
   * lets models without native code execution still benefit — criterion:
   * route to a capable model, then continue with the picked one).
   */
  private buildInterpreterContext(result: CodeInterpreterResult): string {
    const MAX_TEXT_CHARS = 8000;
    const text = ToolRouterEnricher.truncate(result.text, MAX_TEXT_CHARS);
    const fileList = result.generatedFiles.length
      ? `\n\nGenerated files: ${result.generatedFiles
          .map((f) => f.filename)
          .join(
            ', ',
          )}. These are already displayed to the user with previews/download links — refer to them by filename and do NOT fabricate links or re-print their contents.`
      : '';
    return (
      `Code execution results (a sandboxed Python interpreter ran for this request; ` +
      `the executed code and its raw output are shown to the user separately, so do not repeat the code unless asked):\n\n` +
      `${text}${fileList}`
    );
  }

  /**
   * Loads the RAW bytes of the last user message's attachments from blob
   * storage for the sandbox. Raw bytes matter: the interpreter must parse
   * the actual CSV/XLSX, not the text summary the file pipeline produced.
   * Reads from `context.messages` (not enrichedMessages) because
   * processors may have rewritten attachment entries there.
   */
  private async collectInterpreterInputFiles(
    context: ChatContext,
  ): Promise<CodeInterpreterInputFile[]> {
    const MAX_FILES = 4;
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

    const lastMessage = context.messages[context.messages.length - 1];
    if (!Array.isArray(lastMessage?.content)) return [];

    const refs: Array<{
      id: string;
      filename: string;
      location: 'files' | 'images';
    }> = [];
    for (const item of lastMessage.content) {
      if (refs.length >= MAX_FILES) break;
      if (item.type === 'file_url') {
        const f = item as FileMessageContent;
        const id = f.url?.split('/').pop()?.split('?')[0];
        if (id) {
          refs.push({
            id,
            filename: f.originalFilename || id,
            location: 'files',
          });
        }
      } else if (item.type === 'image_url') {
        const img = item as ImageMessageContent;
        const url = img.image_url?.url ?? '';
        // Only blob-backed references; data URLs are legacy and rare.
        if (url.startsWith('/api/file/')) {
          const id = url.split('/').pop()?.split('?')[0];
          if (id) refs.push({ id, filename: id, location: 'images' });
        }
      }
    }
    if (refs.length === 0) return [];

    const userId = getUserIdFromSession(context.session);
    const blobStorageClient = createBlobStorageClient(context.session);
    const files: CodeInterpreterInputFile[] = [];
    let totalBytes = 0;

    for (const ref of refs) {
      try {
        const data = (await blobStorageClient.get(
          `${userId}/uploads/${ref.location}/${ref.id}`,
          BlobProperty.BLOB,
        )) as Buffer;
        if (!Buffer.isBuffer(data)) continue;
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          console.warn(
            '[ToolRouterEnricher] Interpreter input size budget reached; skipping remaining attachments',
          );
          break;
        }
        const extension = ref.filename.split('.').pop() ?? '';
        files.push({
          filename: ref.filename,
          data,
          mimeType: getContentType(extension),
        });
      } catch (err) {
        // A missing blob must not sink the run — the interpreter still gets
        // the task plus whatever attachments DID load.
        console.warn(
          `[ToolRouterEnricher] Could not load attachment for interpreter: ${ref.filename}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return files;
  }

  private static truncate(text: string, maxChars: number): string {
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[…truncated for length]`
      : text;
  }

  /**
   * Prepends context text to a message's content.
   * Handles both string and array content formats.
   */
  private prependContextToMessage(message: Message, context: string): Message {
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: `${context}\n\n---\n\n${message.content}`,
      };
    }

    if (Array.isArray(message.content)) {
      // Prepend to the first text block only
      const hasText = message.content.some((c) => c.type === 'text');
      if (hasText) {
        let modified = false;
        const modifiedContent = message.content.map((c) => {
          if (!modified && c.type === 'text' && 'text' in c) {
            modified = true;
            return { ...c, text: `${context}\n\n---\n\n${c.text}` };
          }
          return c;
        });
        return { ...message, content: modifiedContent };
      }

      // No text content, add as first item
      return {
        ...message,
        content: [{ type: 'text', text: context }, ...message.content],
      };
    }

    // Fallback: convert to string
    return {
      ...message,
      content: `${context}\n\n---\n\n${String(message.content)}`,
    };
  }

  /**
   * Extracts text from complex message content.
   */
  private extractTextFromContent(content: Message['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textContent = content.find((c) => c.type === 'text');
      return textContent && 'text' in textContent
        ? textContent.text
        : '[non-text content]';
    }

    return 'text' in content ? content.text : '[non-text content]';
  }

  /**
   * Gets a model with agentId for search (fallback if context model doesn't have one).
   * Uses GPT-5.2 (agent name 'gpt-52') as the default search agent.
   */
  private getAgentModelForSearch(): OpenAIModel | null {
    const defaultSearchModel = OpenAIModels[OpenAIModelID.GPT_5_2];

    if (!defaultSearchModel || !defaultSearchModel.agentId) {
      console.warn(
        '[ToolRouterEnricher] Default search agent (GPT-5.2) not available or missing agentId',
      );
      return null;
    }

    console.log(
      `[ToolRouterEnricher] Using default search agent: ${defaultSearchModel.name} (${defaultSearchModel.agentId})`,
    );
    return defaultSearchModel;
  }
}
