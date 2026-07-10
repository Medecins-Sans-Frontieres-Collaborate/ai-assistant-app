import { createAnthropicToolUseAccumulator } from '@/lib/services/mcp/anthropicToolUseAccumulator';

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

type Event = Anthropic.RawMessageStreamEvent;

const messageStart = (inputTokens: number): Event =>
  ({
    type: 'message_start',
    message: { usage: { input_tokens: inputTokens, output_tokens: 0 } },
  }) as never;

const messageDelta = (
  outputTokens?: number,
  stopReason?: Anthropic.StopReason,
): Event =>
  ({
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? null, stop_sequence: null },
    usage: outputTokens !== undefined ? { output_tokens: outputTokens } : {},
  }) as never;

const toolUseStart = (index: number, id: string, name: string): Event =>
  ({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  }) as never;

const inputJsonDelta = (index: number, partialJson: string): Event =>
  ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  }) as never;

const textDelta = (text: string): Event =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }) as never;

const thinkingDelta = (thinking: string): Event =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking },
  }) as never;

const signatureDelta = (): Event =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'sig123' },
  }) as never;

describe('createAnthropicToolUseAccumulator', () => {
  it('passes text deltas through and captures end_turn stop', () => {
    const acc = createAnthropicToolUseAccumulator();

    expect(acc.ingest(textDelta('Hello '))).toBe('Hello ');
    expect(acc.ingest(textDelta('world'))).toBe('world');
    acc.ingest(messageDelta(5, 'end_turn'));

    expect(acc.stopReason).toBe('end_turn');
    expect(acc.toolUses()).toEqual([]);
  });

  it('assembles a tool_use fragmented across input_json_delta events', () => {
    const acc = createAnthropicToolUseAccumulator();

    acc.ingest(toolUseStart(1, 'toolu_01A', 'github__list_prs'));
    acc.ingest(inputJsonDelta(1, '{"re'));
    acc.ingest(inputJsonDelta(1, 'po":"a/b"}'));
    acc.ingest(messageDelta(12, 'tool_use'));

    expect(acc.stopReason).toBe('tool_use');
    expect(acc.toolUses()).toEqual([
      {
        id: 'toolu_01A',
        name: 'github__list_prs',
        argumentsJson: '{"repo":"a/b"}',
      },
    ]);
  });

  it('keeps parallel tool_use blocks separate and index-ordered', () => {
    const acc = createAnthropicToolUseAccumulator();

    acc.ingest(toolUseStart(2, 'toolu_B', 'asana__find'));
    acc.ingest(toolUseStart(1, 'toolu_A', 'github__list'));
    acc.ingest(inputJsonDelta(2, '{"q":'));
    acc.ingest(inputJsonDelta(1, '{"repo":"x"}'));
    acc.ingest(inputJsonDelta(2, '"y"}'));

    expect(acc.toolUses()).toEqual([
      { id: 'toolu_A', name: 'github__list', argumentsJson: '{"repo":"x"}' },
      { id: 'toolu_B', name: 'asana__find', argumentsJson: '{"q":"y"}' },
    ]);
  });

  it('defaults an empty-input tool_use to {} (Anthropic sends no fragments)', () => {
    const acc = createAnthropicToolUseAccumulator();

    acc.ingest(toolUseStart(0, 'toolu_A', 'srv__noargs'));

    expect(acc.toolUses()).toEqual([
      { id: 'toolu_A', name: 'srv__noargs', argumentsJson: '{}' },
    ]);
  });

  it('captures usage: input from message_start, cumulative output take-last', () => {
    const acc = createAnthropicToolUseAccumulator();

    acc.ingest(messageStart(120));
    acc.ingest(messageDelta(3));
    acc.ingest(messageDelta(45, 'end_turn'));

    expect(acc.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  it('reports null usage when no usage events arrived', () => {
    const acc = createAnthropicToolUseAccumulator();
    acc.ingest(textDelta('hi'));
    expect(acc.usage).toBeNull();
  });

  it('accumulates thinking without streaming it, and ignores signature deltas', () => {
    const acc = createAnthropicToolUseAccumulator();

    expect(acc.ingest(thinkingDelta('Let me '))).toBe('');
    expect(acc.ingest(thinkingDelta('reason.'))).toBe('');
    expect(acc.ingest(signatureDelta())).toBe('');

    expect(acc.thinking).toBe('Let me reason.');
  });
});
