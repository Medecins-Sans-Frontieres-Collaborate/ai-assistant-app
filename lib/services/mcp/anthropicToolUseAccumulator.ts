import { AssembledToolCall } from './openaiToolCallAccumulator';

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Assembles Anthropic Messages-API stream events into complete tool calls —
 * the Claude twin of createToolCallAccumulator. Pure state machine (no I/O):
 * `content_block_start` (tool_use) opens a call at its block index,
 * `input_json_delta` fragments accrete its arguments, `message_delta`
 * carries the stop_reason and cumulative output tokens.
 *
 * Thinking deltas are accumulated but never returned from ingest() — matching
 * anthropicStreamProcessor, thinking text rides the terminal metadata block,
 * not the display stream. Usage capture lives HERE because MCP turns bypass
 * createAnthropicStreamProcessor.
 */

export interface AnthropicRoundAccumulator {
  /** Feed one stream event; returns any TEXT delta to pass downstream. */
  ingest(event: Anthropic.RawMessageStreamEvent): string;
  stopReason: Anthropic.StopReason | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Accumulated thinking text (never streamed). */
  thinking: string;
  /** Completed tool_use calls in block-index order. Call after stream end. */
  toolUses(): AssembledToolCall[];
}

export function createAnthropicToolUseAccumulator(): AnthropicRoundAccumulator {
  const byIndex = new Map<
    number,
    { id: string; name: string; argumentsJson: string }
  >();
  let stopReason: Anthropic.StopReason | null = null;
  let inputTokens: number | null = null;
  let outputTokens = 0;
  let thinking = '';

  return {
    ingest(event) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage?.input_tokens ?? 0;
          return '';

        case 'message_delta':
          // output_tokens is cumulative — last value wins.
          if (typeof event.usage?.output_tokens === 'number') {
            outputTokens = event.usage.output_tokens;
          }
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          return '';

        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            byIndex.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              argumentsJson: '',
            });
          }
          return '';

        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            return delta.text;
          }
          if (delta.type === 'input_json_delta') {
            const entry = byIndex.get(event.index);
            if (entry) entry.argumentsJson += delta.partial_json;
            return '';
          }
          if (delta.type === 'thinking_delta') {
            thinking += delta.thinking;
            return '';
          }
          // signature_delta / citations_delta: nothing to do. (If extended
          // thinking is ever enabled for Claude, MCP turns must force-disable
          // it — the stateless resume cannot round-trip signed blocks.)
          return '';
        }

        default:
          return '';
      }
    },

    get stopReason() {
      return stopReason;
    },

    get usage() {
      if (inputTokens === null && outputTokens === 0) return null;
      return { inputTokens: inputTokens ?? 0, outputTokens };
    },

    get thinking() {
      return thinking;
    },

    toolUses() {
      return [...byIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => ({
          id: entry.id,
          name: entry.name,
          // Anthropic emits zero input_json_delta fragments for {} inputs.
          argumentsJson: entry.argumentsJson || '{}',
        }))
        .filter((call) => call.id && call.name);
    },
  };
}
