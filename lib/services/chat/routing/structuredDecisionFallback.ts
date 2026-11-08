/**
 * Second chance for an auxiliary routing decision.
 *
 * The tool router and the document-trim classifier run on the auxiliary
 * model chain (lib/services/auxiliary). When every candidate in that chain
 * fails (EU auxiliary deployment missing or not residency-eligible, policy
 * storage unreachable, throttling), the router used to answer "no tools".
 * For a model without a native code interpreter that silently turned
 * "produce a Word report from these five files" into a chat answer: no
 * code ran, no file was produced (reproduced 2026-11-07, Mistral-Large-3,
 * EU). The user's own chat model is, by construction, allowed to process
 * this conversation in this region, so it can make the decision instead.
 * It costs one extra call on the chat model, and only when the auxiliary
 * chain has already failed.
 */
import type { TokenUsageMetadata } from '@/lib/utils/app/metadata';

import type { OpenAIModel } from '@/types/openai';

import type OpenAI from 'openai';

/** The decision request, in the router's own (OpenAI chat) shape. */
export type StructuredDecisionParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** A decision made by the fallback model. */
export interface StructuredDecisionResult {
  /** The JSON object the model produced, as text (not yet validated). */
  text: string;
  /** The model that answered. */
  model: OpenAIModel;
  /** Region the call was served from; null = default (home) clients. */
  region: 'US' | 'EU' | null;
  usage?: Omit<TokenUsageMetadata, 'modelId' | 'region'>;
}

/**
 * Makes one structured decision with a model other than the auxiliary
 * chain. The caller validates the result exactly as it validates an
 * auxiliary response.
 *
 * @throws When the model cannot be reached or returns no JSON object.
 */
export type StructuredDecisionFallback = (
  params: StructuredDecisionParams,
  signal?: AbortSignal,
) => Promise<StructuredDecisionResult>;

/** The chat model (and the caller's residency) a fallback decision runs on. */
export interface StructuredDecisionTarget {
  model: OpenAIModel;
  userRegion?: 'US' | 'EU' | null;
  hostedRegion?: 'US' | 'EU';
}

/** Something that can make a structured decision with the user's chat model. */
export interface StructuredDecisionProvider {
  completeStructuredDecision(
    target: StructuredDecisionTarget,
    params: StructuredDecisionParams,
    signal?: AbortSignal,
  ): Promise<StructuredDecisionResult>;
}

/** Most a fallback decision may take before the router gives up on it. */
export const STRUCTURED_DECISION_FALLBACK_TIMEOUT_MS = 30_000;

/**
 * Output budget for the fallback call. The auxiliary budgets are sized for
 * a non-reasoning nano model; a chat model may spend reasoning tokens
 * first, so it gets several times the room (bounded by its own limit).
 */
export function fallbackDecisionMaxTokens(
  auxiliaryBudget: number | null | undefined,
  modelTokenLimit: number | undefined,
): number {
  const wanted = Math.max(2_000, (auxiliaryBudget ?? 0) * 4);
  return modelTokenLimit ? Math.min(wanted, modelTokenLimit) : wanted;
}

/**
 * Pulls the JSON object out of a model reply that may wrap it in reasoning
 * (`<think>…</think>`), a markdown fence, or a sentence of preamble.
 *
 * @returns The object's text, or undefined when there is none.
 *
 * @example
 * extractJsonObject('<think>…</think>\n```json\n{"a":1}\n```'); // => '{"a":1}'
 */
export function extractJsonObject(
  text: string | null | undefined,
): string | undefined {
  if (!text) return undefined;
  const visible = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = visible.indexOf('{');
  const end = visible.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  const candidate = visible.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Instruction appended to the system prompt for models that cannot be
 * held to a JSON schema by the API (third-party models on the Foundry
 * OpenAI-compatible endpoint).
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return (
    'Reply with ONLY one JSON object that matches this JSON schema — no prose, no markdown fence:\n' +
    JSON.stringify(schema)
  );
}

type RouterMessage = { role: string; content?: unknown };

/** Plain text of a router message (the router only sends text). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('\n');
  return '';
}

/**
 * Converts the router's OpenAI-style message list to Anthropic's shape:
 * system text separated out, and strictly alternating user/assistant turns
 * starting with the user (consecutive same-role turns are merged).
 */
export function toAnthropicMessages(messages: readonly RouterMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const system: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    const text = textOf(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      system.push(text);
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = turns[turns.length - 1];
    if (previous?.role === role) previous.content += `\n\n${text}`;
    else turns.push({ role, content: text });
  }
  if (turns[0]?.role === 'assistant')
    turns.unshift({ role: 'user', content: '(conversation continues)' });
  return { system: system.join('\n\n'), messages: turns };
}
