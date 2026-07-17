import type OpenAI from 'openai';

/**
 * Assembles streamed chat.completions `delta.tool_calls` fragments into
 * complete tool calls. Pure state machine (no I/O) so the tool loop's most
 * fragile part — fragment reassembly across chunk boundaries and parallel
 * calls — is unit-testable in isolation.
 */

export interface AssembledToolCall {
  /** Provider call id (`call_…`); doubles as the approval_request_id. */
  id: string;
  /** Model-facing function name (serverId__toolName). */
  name: string;
  /** Concatenated arguments JSON exactly as the model emitted it. */
  argumentsJson: string;
}

export interface ToolCallAccumulator {
  /** Feed one streamed chunk; returns any text delta to pass downstream. */
  ingest(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): string;
  finishReason: string | null;
  usage: OpenAI.Completions.CompletionUsage | null;
  /** Completed calls, in index order. Call after the stream ends. */
  toolCalls(): AssembledToolCall[];
}

export function createToolCallAccumulator(): ToolCallAccumulator {
  // delta.tool_calls fragments carry an `index`; id/name arrive on the first
  // fragment, argument text accretes across subsequent ones.
  const byIndex = new Map<
    number,
    { id: string; name: string; argumentsJson: string }
  >();
  let finishReason: string | null = null;
  let usage: OpenAI.Completions.CompletionUsage | null = null;

  return {
    ingest(chunk) {
      // The usage chunk (stream_options.include_usage) has no choices.
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return '';
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      for (const fragment of choice.delta?.tool_calls ?? []) {
        const entry = byIndex.get(fragment.index) ?? {
          id: '',
          name: '',
          argumentsJson: '',
        };
        if (fragment.id) entry.id = fragment.id;
        if (fragment.function?.name) entry.name += fragment.function.name;
        if (fragment.function?.arguments) {
          entry.argumentsJson += fragment.function.arguments;
        }
        byIndex.set(fragment.index, entry);
      }
      return choice.delta?.content ?? '';
    },

    get finishReason() {
      return finishReason;
    },

    get usage() {
      return usage;
    },

    toolCalls() {
      return [...byIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => ({
          id: entry.id,
          name: entry.name,
          argumentsJson: entry.argumentsJson || '{}',
        }))
        .filter((call) => call.id && call.name);
    },
  };
}
