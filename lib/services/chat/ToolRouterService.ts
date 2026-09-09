import { devTrace } from '@/lib/utils/server/debug/devTrace';

import {
  Message,
  ToolRouterRequest,
  ToolRouterResponse,
  ToolType,
} from '@/types/chat';

import { TrimTarget, WORDS_PER_PAGE } from './tools/documentTrim/trimDetector';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OpenAI } from 'openai';

/** Classifier output for the document-trim intent (strict schema). */
interface TrimClassification {
  isLengthReductionRequest: boolean;
  targetIsAttachedDocument: boolean;
  targetValue: number;
  targetUnit: 'words' | 'characters' | 'pages' | 'percent_to_keep' | 'none';
}

const TRIM_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    isLengthReductionRequest: {
      type: 'boolean',
      description:
        'True ONLY when the last user message asks to reduce/shorten something to an explicit target length.',
    },
    targetIsAttachedDocument: {
      type: 'boolean',
      description:
        'True when the thing being shortened is the attached document file itself. False when it is text written or pasted directly into the conversation (a draft the user typed, a previous assistant reply, quoted text).',
    },
    targetValue: {
      type: 'number',
      description:
        'The numeric target (word/character/page count, or percent of the original to KEEP). 0 when not a length-reduction request.',
    },
    targetUnit: {
      type: 'string',
      enum: ['words', 'characters', 'pages', 'percent_to_keep', 'none'],
      description: '"none" when not a length-reduction request.',
    },
  },
  required: [
    'isLengthReductionRequest',
    'targetIsAttachedDocument',
    'targetValue',
    'targetUnit',
  ],
  additionalProperties: false,
} as const;

/**
 * ToolRouterService
 *
 * Determines which tools are needed for a given message using gpt-5.4-nano.
 * Uses a lightweight model to intelligently decide when web search is beneficial.
 */
export class ToolRouterService {
  private tracer = trace.getTracer('tool-router-service');

  constructor(private openAIClient: OpenAI) {}

  /**
   * Multilingual intent classification for the dedicated document-trim
   * pipeline. Called ONLY when the factual precondition holds (a trimmable
   * document is attached to the conversation) — the classifier answers the
   * language-dependent half: did the user ask to reduce that document to a
   * target length, and what is the target? Users write in any of the app's
   * 33 languages, so this is deliberately an LLM call, not a keyword match.
   *
   * Returns a resolved TrimTarget, or null (not a trim request, or the
   * classifier failed — the turn then degrades to normal routing).
   */
  async classifyDocumentTrim(request: {
    messages: Message[];
    currentMessage: string;
    documentFilename: string;
  }): Promise<TrimTarget | null> {
    try {
      const recentMessages = this.getRecentMessages(request.messages, 6);
      const lastIndex = recentMessages.length - 1;

      const systemPrompt = `You classify whether the user's LAST message asks to REDUCE an attached document to a target length. The attached document is: ${request.documentFilename}

Users write in ANY language — classify by MEANING, never by keywords.

isLengthReductionRequest is true ONLY when the message asks to shorten/trim/condense something AND gives an explicit target:
- a count of words, characters, or pages ("à 6000 mots", "auf 3000 Wörter kürzen", "reducir a 5 páginas"), or
- a fraction/percentage of the original ("cut it in half" → 50 percent_to_keep; "reduce by 30%" → 70 percent_to_keep; "देखें आधा कर दो" → 50 percent_to_keep).
Follow-up phrasings count when the conversation shows a pending trim request ("please do it", "vas-y").

It is FALSE for: summarizing, critiquing, translating, expanding, formatting, questions about the document, or length mentions that are not reduction targets ("the doc is 6000 words — fix the typos").

targetIsAttachedDocument identifies WHAT is being shortened. It is true only when the request refers to the attached document file (${request.documentFilename}). It is FALSE when the user wants to shorten text that lives in the conversation itself — a draft they typed or pasted into the chat, a previous assistant answer, a quoted passage — even if a file was uploaded earlier in the conversation. When the last messages revolve around conversation text rather than the file, the file is not the target.

When true: set targetValue and targetUnit. When false: targetValue 0, targetUnit "none".`;

      const response = await this.openAIClient.chat.completions.create({
        model: 'gpt-5.4-nano',
        messages: [
          { role: 'system' as const, content: systemPrompt },
          ...recentMessages.map((msg, index) => ({
            role: msg.role as 'user' | 'assistant' | 'system',
            content:
              index === lastIndex
                ? request.currentMessage
                : typeof msg.content === 'string'
                  ? msg.content
                  : this.extractTextContent(msg.content),
          })),
        ],
        reasoning_effort: 'minimal',
        max_completion_tokens: 60,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'document_trim_classification',
            strict: true,
            schema: TRIM_CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TrimClassification;
      return ToolRouterService.toTrimTarget(parsed);
    } catch (error) {
      // Degrade to normal routing — a dead classifier must not block chat.
      console.error(
        '[ToolRouterService] Document-trim classification failed:',
        error instanceof Error ? error.message : error,
      );
      // TEMP DEBUG (see devTrace.ts) — DELETE before merge.
      devTrace('trim-classify-error', {
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      return null;
    }
  }

  /** Deterministic unit mapping — arithmetic stays out of the model. */
  private static toTrimTarget(
    classification: TrimClassification,
  ): TrimTarget | null {
    const {
      isLengthReductionRequest,
      targetIsAttachedDocument,
      targetValue,
      targetUnit,
    } = classification;
    // Both halves must hold: a length target alone is not enough — the
    // pipeline exists to preserve FILE formatting, so shortening text that
    // lives in the chat (a pasted draft, a prior answer) must stay a normal
    // chat turn even while a trimmable file sits earlier in the conversation.
    if (
      !isLengthReductionRequest ||
      !targetIsAttachedDocument ||
      targetUnit === 'none' ||
      !Number.isFinite(targetValue) ||
      targetValue <= 0
    ) {
      return null;
    }
    switch (targetUnit) {
      case 'words':
        return {
          kind: 'absolute',
          unit: 'words',
          target: Math.round(targetValue),
          approx: false,
        };
      case 'characters':
        return {
          kind: 'absolute',
          unit: 'characters',
          target: Math.round(targetValue),
          approx: false,
        };
      case 'pages':
        return {
          kind: 'absolute',
          unit: 'words',
          target: Math.round(targetValue * WORDS_PER_PAGE),
          approx: true,
        };
      case 'percent_to_keep':
        if (targetValue >= 100) return null;
        return { kind: 'ratio', keep: targetValue / 100, approx: true };
      default:
        return null;
    }
  }

  /**
   * Determines which tools are needed for the current message.
   *
   * @param request - ToolRouterRequest with messages and forceWebSearch flag
   * @returns ToolRouterResponse with tools array and optional searchQuery
   */
  async determineTool(request: ToolRouterRequest): Promise<ToolRouterResponse> {
    return await this.tracer.startActiveSpan(
      'tool_router.determine',
      {
        attributes: {
          'tool_router.force_web_search': request.forceWebSearch || false,
          'tool_router.message_length': request.currentMessage.length,
          'tool_router.has_user_provided_content':
            request.hasUserProvidedContent || false,
        },
      },
      async (span) => {
        try {
          const {
            currentMessage,
            forceWebSearch,
            forceCodeInterpreter,
            hasPriorSearchCitations,
            hasUserProvidedContent,
          } = request;
          const considerCodeExecution =
            request.considerCodeExecution || forceCodeInterpreter;

          // Forced modes skip the AI decision entirely. Both tools can be
          // forced at once (search ALWAYS + interpreter ALWAYS) — return
          // both; the enricher executes them in sequence.
          if (forceWebSearch || forceCodeInterpreter) {
            const tools: ToolType[] = [];
            if (forceWebSearch) tools.push('web_search');
            if (forceCodeInterpreter) tools.push('code_interpreter');
            console.log(
              `[ToolRouterService] Forced tools [${tools.join(', ')}], skipping AI decision`,
            );
            span.setAttribute(
              'tool_router.decision',
              `forced_${tools.join('_')}`,
            );
            span.setStatus({ code: SpanStatusCode.OK });
            return {
              tools,
              searchQuery: forceWebSearch ? currentMessage : undefined,
              codeTask: forceCodeInterpreter ? currentMessage : undefined,
              reasoning: 'Forced tool mode',
            };
          }

          // Use an efficient model to determine if web search is needed
          // This uses the standard OpenAI client which can route to any model
          try {
            // Anchor the router in real time: without this the model's
            // training-era sense of "now" leaks stale years into generated
            // queries (e.g. appending "2024 2025" to a 2026 question).
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentDate = now.toISOString().slice(0, 10);

            const codeExecutionPromptSection = considerCodeExecution
              ? `

You ALSO determine if sandboxed code execution (Python) would materially improve the answer.

The user message may be followed by bracketed context lines: file/summary/transcript EXCERPTS, and an attachment manifest ("[Files attached to the current message: …]" / "[Files uploaded earlier in this conversation: …]"). When the user says "this", "the document", or "the file", they mean those attached files — including ones uploaded on an earlier turn. The sandbox receives the real files, so a task on a previously uploaded file is fully executable.

Code execution is needed for:
- Data analysis over attached files or pasted tabular data (CSV, Excel, JSON)
- Chart / plot / visualization generation
- Non-trivial calculations, statistics, simulations, or numeric verification
- File transformations (parse, filter, aggregate, convert, export)
- Producing downloadable files (Excel, CSV, Word, charts) from data or content in the conversation — e.g. "export this as a spreadsheet", "make a document out of these notes"
- Editing an ATTACHED document into a new version of itself — shortening or trimming it to a target length (words, characters, or pages), restructuring, reformatting, or converting it — the deliverable is a new file in the original format

Code execution is NOT needed for:
- Writing code examples or tutorials for the user to run themselves
- Explaining concepts, debugging by inspection, code review
- Simple arithmetic a model can do reliably
- Pure text tasks answered directly in chat (writing, translating, or summarizing pasted text). But when the request is to shorten, rewrite, translate, or reformat an ATTACHED FILE, that is a file transformation and DOES need code execution — regardless of whether the target is expressed in words, characters, or pages

IMPORTANT: Always provide codeTask in your response:
- If needsCodeExecution is true, provide a self-contained task description (what to compute/produce, referencing attached files by their exact names from the manifest — current-turn OR earlier-turn)
- If needsCodeExecution is false, provide an empty string`
              : '';

            const providedContentPromptSection = hasUserProvidedContent
              ? `

CRITICAL: The user supplied their own source material this turn (uploaded files and/or a large pasted text block) that they want processed. Default to needsWebSearch=false — pulling in web results would dilute the sources they provided. Set needsWebSearch=true ONLY when the message EXPLICITLY asks to search the web or bring in external/up-to-date information (e.g. "search for...", "look this up online", "find recent news about...", "compare this with current data"). Summarizing, analyzing, translating, rewriting, extracting from, or answering questions about the provided material is NOT a search request, even when that material mentions current events.`
              : '';

            const followUpPromptSection = hasPriorSearchCitations
              ? `

This conversation already contains web-search results with cited articles. ALSO decide searchFollowUp:
- true when the user is asking for more detail, clarification, or analysis of those previously cited articles/results ("what did the Reuters piece say", "more on the second article", "summarize those sources") — the system will fetch the cited articles' full text
- false when the question is a new topic or needs fresh information (use needsWebSearch for that)
- Both can be true when the user wants deeper detail AND new information`
              : '';

            const systemPrompt = `You are a tool router that determines if web search is needed.

Today's date is ${currentDate}. The current year is ${currentYear}.

Analyze the user's message in the context of the conversation and determine if it requires current, real-time information from the web.

Web search is needed for:
- Current events, news, recent developments
- Real-time data (weather, stock prices, scores)
- Recent information (released after ${currentYear - 1})
- Specific facts that change frequently
- Comparisons requiring current data

Web search is NOT needed for:
- General knowledge, concepts, explanations
- Code writing, debugging, tutorials
- Mathematical calculations
- Creative writing, brainstorming
- Personal advice, opinions
- Questions about uploaded files or images${providedContentPromptSection}

IMPORTANT: Always provide searchQuery in your response:
- If needsWebSearch is true, provide a CONCISE search-engine query: 3-8 keywords, ONE topic, no question words ("what", "where", "why"), no filler ("current updates", "reasons", "dates"). Bad: "latest protests in India what are they about where are they happening dates reasons current updates". Good: "India protests ${currentYear}"
- Years in queries: do NOT append a year by default. Append the current year (${currentYear}) ONLY when the question implies recency (news, "latest", ongoing events). Use a past year ONLY when the user explicitly asks about that period. Never append speculative, future, or multiple years.
- If needsWebSearch is false, provide an empty string

Also tune the search when needsWebSearch is true:
- searchRecency: "day" for breaking news/live data, "week" or "month" for recent developments, "none" when age doesn't matter
- searchComprehensive: true for research-style questions wanting breadth (comparisons, overviews, "what are my options"), false for single-fact lookups
- additionalSearchQueries: almost always EMPTY — one query should cover the question whenever possible. Populate ONLY when the message contains multiple clearly SEPARABLE information needs that no single query can cover (e.g. "compare the France strikes with the Germany rail dispute" → one extra query). Max 4 extra queries; each follows the same 3-8 keyword rules. Never split one topic into variations of the same query${followUpPromptSection}${codeExecutionPromptSection}`;

            // Include recent conversation history for context-aware decisions
            // Take last 3 message pairs (6 messages max) to keep it efficient
            const recentMessages = this.getRecentMessages(request.messages, 6);

            // Build messages array with conversation context. The LAST
            // message is replaced by `currentMessage`: the enricher-built
            // routing input carrying what the raw message text cannot —
            // file/summary excerpts and the attachment manifest. Without
            // that substitution the classifier sees "trim this to 6k words"
            // with no evidence any file exists, and can only classify it as
            // a pure text task.
            const lastIndex = recentMessages.length - 1;
            const conversationMessages = [
              { role: 'system' as const, content: systemPrompt },
              ...recentMessages.map((msg, index) => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content:
                  index === lastIndex
                    ? request.currentMessage
                    : typeof msg.content === 'string'
                      ? msg.content
                      : this.extractTextContent(msg.content),
              })),
            ];

            console.log('[ToolRouterService] Using conversation context:', {
              messagesCount: recentMessages.length,
              lastMessage: currentMessage.substring(0, 100),
            });

            // gpt-5.4-nano: cheapest/fastest tier for the routing decision.
            // reasoning_effort minimal + a small token cap keeps latency low.
            // The cap grows when code execution is considered because the
            // schema then carries a codeTask sentence as well.
            const schemaProperties: Record<string, unknown> = {
              needsWebSearch: {
                type: 'boolean',
                description: 'Whether web search is needed for this query',
              },
              searchQuery: {
                type: 'string',
                description:
                  'Concise search-engine query (3-8 keywords, one topic, no question words) if web search is needed, empty string otherwise',
              },
              searchRecency: {
                type: 'string',
                enum: ['day', 'week', 'month', 'none'],
                description:
                  'How recent results must be when searching; "none" when age does not matter',
              },
              searchComprehensive: {
                type: 'boolean',
                description:
                  'Whether the question wants breadth (many sources) rather than a single fact',
              },
              additionalSearchQueries: {
                type: 'array',
                items: { type: 'string' },
                maxItems: 4,
                description:
                  'Usually empty. Extra queries ONLY for clearly separable aspects one query cannot cover (max 4)',
              },
            };
            const requiredFields = [
              'needsWebSearch',
              'searchQuery',
              'searchRecency',
              'searchComprehensive',
              'additionalSearchQueries',
            ];
            if (hasPriorSearchCitations) {
              schemaProperties.searchFollowUp = {
                type: 'boolean',
                description:
                  'Whether the question is a follow-up about the previously cited search results/articles',
              };
              requiredFields.push('searchFollowUp');
            }
            if (considerCodeExecution) {
              schemaProperties.needsCodeExecution = {
                type: 'boolean',
                description:
                  'Whether sandboxed code execution is needed for this query',
              };
              schemaProperties.codeTask = {
                type: 'string',
                description:
                  'Self-contained task for the code interpreter if needed, empty string otherwise',
              };
              requiredFields.push('needsCodeExecution', 'codeTask');
            }

            const response = await this.openAIClient.chat.completions.create({
              model: 'gpt-5.4-nano',
              messages: conversationMessages,
              reasoning_effort: 'minimal',
              // +60 headroom for the (usually empty) additionalSearchQueries
              // array — a populated fan-out is a few short keyword strings.
              max_completion_tokens:
                (considerCodeExecution ? 280 : 200) +
                (hasPriorSearchCitations ? 20 : 0),
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'tool_router_response',
                  strict: true,
                  schema: {
                    type: 'object',
                    properties: schemaProperties,
                    required: requiredFields,
                    additionalProperties: false,
                  },
                },
              },
            });

            const result = JSON.parse(
              response.choices[0].message.content || '{}',
            );

            console.log('[ToolRouterService] AI decision:', result);

            span.setAttribute(
              'tool_router.needs_web_search',
              result.needsWebSearch,
            );
            span.setAttribute(
              'tool_router.needs_code_execution',
              result.needsCodeExecution ?? false,
            );
            span.setStatus({ code: SpanStatusCode.OK });

            const tools: ToolType[] = [];
            if (result.needsWebSearch) {
              span.setAttribute('tool_router.search_query', result.searchQuery);
              tools.push('web_search');
            }
            if (considerCodeExecution && result.needsCodeExecution) {
              tools.push('code_interpreter');
            }

            // Follow-up classification is independent of the tools array:
            // "summarize those articles" needs the cited-source fetch even
            // when no fresh search is warranted.
            const searchFollowUp =
              hasPriorSearchCitations === true &&
              result.searchFollowUp === true;

            // Fan-out: primary query first, then any genuinely separable
            // extra aspects. Deduped, blank-filtered, hard-capped at 5.
            const primaryQuery = result.needsWebSearch
              ? result.searchQuery || currentMessage
              : undefined;
            const searchQueries = primaryQuery
              ? [
                  primaryQuery,
                  ...(Array.isArray(result.additionalSearchQueries)
                    ? result.additionalSearchQueries.filter(
                        (q: unknown): q is string =>
                          typeof q === 'string' &&
                          q.trim().length > 0 &&
                          q.trim() !== primaryQuery,
                      )
                    : []),
                ].slice(0, 5)
              : undefined;

            if (tools.length > 0 || searchFollowUp) {
              const recency = result.searchRecency;
              return {
                tools,
                searchQuery: primaryQuery,
                searchQueries,
                searchRecency:
                  result.needsWebSearch &&
                  (recency === 'day' ||
                    recency === 'week' ||
                    recency === 'month')
                    ? recency
                    : undefined,
                searchComprehensive:
                  result.needsWebSearch && result.searchComprehensive === true,
                searchFollowUp,
                codeTask:
                  considerCodeExecution && result.needsCodeExecution
                    ? result.codeTask || currentMessage
                    : undefined,
                reasoning: 'Tools recommended by AI',
              };
            }

            return {
              tools: [] as ToolType[],
              reasoning: 'No tools needed',
            };
          } catch (error) {
            // Make the silent-degradation path loud. If gpt-5.4-nano ever
            // rejects `reasoning_effort: 'minimal'` or the JSON schema
            // changes shape, every routing decision falls back to "no
            // search" — which is a real regression, not just a transient
            // failure. Mark it on the span so it surfaces in telemetry,
            // and log with enough detail to diagnose without re-running.
            const errMessage =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[ToolRouterService] Falling back to no-tools (web_search disabled). Cause: ${errMessage}`,
            );
            // TEMP DEBUG (see devTrace.ts) — DELETE before merge.
            devTrace('tool-router-error', { error: errMessage.slice(0, 300) });
            span.recordException(error as Error);
            span.setAttribute('tool_router.fallback', 'error');
            span.setAttribute('tool_router.fallback_reason', errMessage);
            return {
              tools: [],
              degraded: true,
              reasoning: 'Error determining tools, proceeding without search',
            };
          }
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Gets the most recent messages from the conversation for context.
   * Limits to maxMessages to keep the tool routing efficient.
   */
  private getRecentMessages(
    messages: Message[],
    maxMessages: number,
  ): Message[] {
    if (messages.length <= maxMessages) {
      return messages;
    }
    return messages.slice(-maxMessages);
  }

  /**
   * Extracts text content from complex message content structures.
   * Handles string, array, and object content types.
   */
  private extractTextContent(content: Message['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''));
      return textParts.join('\n');
    }

    return 'text' in content ? content.text : '';
  }
}
