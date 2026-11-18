/**
 * Search-query reformulation for knowledge-base retrieval (org RAG agents and
 * M365 file-backed agents), under the user's data residency.
 *
 * The rewrite sends the user's conversation to a model, so it follows the
 * same residency rules as every other helper model call:
 *
 * 1. The auxiliary `query` operation on the user's region chain. Only
 *    deployments verified to process data in that region are candidates
 *    (see lib/services/auxiliary/resolution.ts); EU users always resolve EU.
 * 2. The user's own chat model, which already runs in the user's region or
 *    on their custom-source account (StandardChatService.completeText).
 * 3. The raw question: retrieval quality degrades, the request never does.
 *
 * All three share one deadline, so a slow rewrite can never consume the
 * retrieval stage's budget (a stage timeout drops every search result).
 */
import { auxiliaryFailure } from '@/lib/services/auxiliary/AuxiliaryModelExecutor';
import {
  type AuxiliaryAnswerSource,
  AuxiliaryCompletionService,
  textCallParams,
} from '@/lib/services/auxiliary/auxiliaryCompletion';
import type { AuxiliaryTurnRouting } from '@/lib/services/chat/auxiliaryTurnRouting';

import type { Message } from '@/types/chat';

import type OpenAI from 'openai';

/** Most the whole rewrite (auxiliary chain plus chat-model fallback) may take. */
export const QUERY_REFORMULATION_TIMEOUT_MS = 5_000;

/** Output budget for the rewrite: a search query, not prose. */
export const QUERY_REFORMULATION_MAX_TOKENS = 200;

/**
 * Output budget when the user's chat model does the rewrite. Larger than the
 * auxiliary budget: a chat model may be a reasoning model without a
 * minimal effort, and its reasoning tokens count against this cap.
 */
export const QUERY_REFORMULATION_FALLBACK_MAX_TOKENS = 1_000;

/** A longer reply is the model answering instead of rewriting; discard it. */
export const MAX_REFORMULATED_QUERY_CHARS = 500;

/** The prompts one rewrite sends. */
export interface QueryReformulationPrompt {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Where a rewrite may run: the slice of a chat turn's helper-call routing
 * (lib/services/chat/auxiliaryTurnRouting.ts) a rewrite uses.
 */
export type QueryReformulationRouting = Pick<
  AuxiliaryTurnRouting,
  'region' | 'signal' | 'textFallback'
> &
  Partial<Pick<AuxiliaryTurnRouting, 'onUsage'>>;

/** Which path produced a rewrite, for logs and tests. */
export type QueryReformulationSource = AuxiliaryAnswerSource;

/**
 * The text of a message, from any content shape: a plain string, a single
 * part, or a list of parts (text plus attached files or images). Non-text
 * parts are skipped, so a question asked alongside an attachment is still
 * found.
 *
 * @param content - A message's content.
 * @returns The text parts joined by newlines, trimmed; empty when none.
 */
export function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content.trim();
  const parts: unknown[] = Array.isArray(content) ? content : [content];
  return parts
    .map((part) =>
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * The latest user question in a conversation.
 *
 * @param messages - The conversation, oldest first.
 * @returns The last user message's text; empty when there is none or it
 *          carries no text (an image-only turn).
 */
export function latestUserQuestion(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user')
      return messageText(messages[index].content);
  }
  return '';
}

/** Conversation turns the rewrite sees: enough to resolve a follow-up. */
export const REWRITE_HISTORY_TURNS = 5;

/** Per-turn character cap in the rewrite's history. */
export const REWRITE_HISTORY_TURN_CHARS = 1_000;

/**
 * The conversation as the rewrite sees it: the last few user and assistant
 * turns, text only, each capped. System messages are excluded on purpose:
 * pipeline stages prepend them with whole inlined documents and summaries,
 * which would turn a one-line rewrite into a slow, large request (and send
 * the documents to the rewrite model for no benefit).
 *
 * @param messages - The conversation, oldest first.
 * @returns One `role: text` line per turn; attachments-only turns read
 *          `[attachment]`.
 */
export function rewriteConversationHistory(messages: Message[]): string {
  return messages
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
    .slice(-REWRITE_HISTORY_TURNS)
    .map((message) => {
      const text = messageText(message.content) || '[attachment]';
      const capped =
        text.length > REWRITE_HISTORY_TURN_CHARS
          ? `${text.slice(0, REWRITE_HISTORY_TURN_CHARS)}…`
          : text;
      return `${message.role}: ${capped}`;
    })
    .join('\n');
}

/**
 * Builds the org knowledge-base rewrite prompt. Temporal phrases become
 * explicit months because the index is vector-searched and "this week" has
 * no useful embedding.
 *
 * @param conversationHistory - Recent turns, one `role: text` line each.
 * @param originalQuery - The user's latest question.
 * @param now - The current date (injected for tests and probes).
 */
export function buildKnowledgeBaseReformulationPrompt(
  conversationHistory: string,
  originalQuery: string,
  now: Date = new Date(),
): QueryReformulationPrompt {
  const currentMonth = now.toLocaleString('en-US', { month: 'long' });
  const currentYear = now.getFullYear();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthName = lastMonth.toLocaleString('en-US', { month: 'long' });
  const lastMonthYear = lastMonth.getFullYear();

  const systemPrompt = `You are a search query optimizer for Azure AI Search. Today is ${currentMonth} ${now.getDate()}, ${currentYear}.

        Your task is to create concise, effective search queries that:
        1. CONVERT temporal references to ACTUAL dates/months (this is critical for vector search)
        2. Include key entities and concepts from the original query
        3. Work effectively with Azure AI Search semantic ranking

        CRITICAL - TEMPORAL CONVERSION RULES:
        - "this week" / "recent" / "latest" / "current" → "${currentMonth} ${currentYear}"
        - "last week" / "last month" → "${lastMonthName} ${lastMonthYear}" or "${currentMonth} ${currentYear}"
        - "today" / "now" → "${currentMonth} ${now.getDate()} ${currentYear}"
        - "this year" → "${currentYear}"
        - Keep historical queries unchanged (e.g., "2023 earthquake" stays as-is)

        GUIDELINES FOR AZURE AI SEARCH:
        - Keep queries CONCISE (under 20 words)
        - Focus on CORE CONCEPTS and ENTITIES
        - Use NATURAL LANGUAGE phrasing
        - ALWAYS include the actual month/year when recency is implied
        - Avoid complex boolean operators or syntax

        EXAMPLES:
        - "what did MSF say about Pakistan this week" → "MSF Pakistan ${currentMonth} ${currentYear}"
        - "latest news on Gaza" → "Gaza humanitarian crisis ${currentMonth} ${currentYear}"
        - "recent updates Sudan" → "Sudan ${currentMonth} ${currentYear} updates"
        - "MSF response to 2023 earthquake" → "MSF 2023 earthquake response" (historical, no change)

        Return ONLY the reformulated search query with no additional text.`;

  return {
    systemPrompt,
    userPrompt: `Conversation history:\n${conversationHistory}\n\nOriginal query: ${originalQuery}\n\nGenerate an improved Azure AI Search query that captures the key concepts and appropriately handles recency.`,
  };
}

/**
 * The request a rewrite sends on the auxiliary chain (also the readiness
 * probe's request). The executor fills the deployment and adapts parameters
 * to it (reasoning models get their lowest supported effort).
 */
export function queryReformulationRequest(
  prompt: QueryReformulationPrompt,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return textCallParams(
    prompt.systemPrompt,
    prompt.userPrompt,
    QUERY_REFORMULATION_MAX_TOKENS,
  );
}

/**
 * Accepts a rewrite only when it looks like a query: non-empty, single
 * block, and short. Quotes the model wraps around it are stripped.
 *
 * @returns The cleaned query, or undefined to reject the reply.
 */
export function acceptReformulatedQuery(
  text: string | null | undefined,
): string | undefined {
  const query = text
    ?.trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!query || query.length > MAX_REFORMULATED_QUERY_CHARS) return undefined;
  return query;
}

/**
 * Runs rewrites through the shared helper-model path
 * (AuxiliaryCompletionService, operation `query`). One instance is shared
 * process-wide (ServiceContainer); it holds no per-request state.
 */
export class QueryReformulator {
  /**
   * @param completions - The shared helper-model service; without one, a
   *        rewrite can only use the chat-model fallback.
   * @param timeoutMs - Shared deadline for every attempt of one rewrite.
   */
  constructor(
    private readonly completions: AuxiliaryCompletionService = new AuxiliaryCompletionService(),
    private readonly timeoutMs: number = QUERY_REFORMULATION_TIMEOUT_MS,
  ) {}

  /**
   * Rewrites a question into a search query.
   *
   * @param prompt - The prompts to send (see the build* helpers).
   * @param routing - Residency region, chat-model fallback, usage sink.
   * @returns The query and the path that produced it, or undefined when no
   *          path produced an acceptable query in time (the caller then
   *          searches with the raw question). Never throws.
   */
  async reformulate(
    prompt: QueryReformulationPrompt,
    routing: QueryReformulationRouting,
  ): Promise<{ query: string; source: QueryReformulationSource } | undefined> {
    const started = Date.now();
    try {
      const answer = await this.completions.completeText({
        operation: 'query',
        region: routing.region,
        timeoutMs: this.timeoutMs,
        signal: routing.signal,
        onUsage: routing.onUsage,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        maxTokens: QUERY_REFORMULATION_MAX_TOKENS,
        fallbackMaxTokens: QUERY_REFORMULATION_FALLBACK_MAX_TOKENS,
        accept: acceptReformulatedQuery,
        fallback: routing.textFallback,
      });
      console.log(
        `[Perf] QueryReformulator: ${Date.now() - started}ms via ${answer.source} (${routing.region})`,
      );
      return { query: answer.value, source: answer.source };
    } catch (error) {
      console.warn(
        `[QueryReformulator] No ${routing.region} rewrite (${auxiliaryFailure(error).reason}); using the raw question`,
      );
      return undefined;
    }
  }
}
