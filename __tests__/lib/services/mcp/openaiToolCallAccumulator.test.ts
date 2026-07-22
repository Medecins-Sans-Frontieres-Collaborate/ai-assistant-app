import { createToolCallAccumulator } from '@/lib/services/mcp/openaiToolCallAccumulator';

import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

function chunk(partial: {
  content?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    args?: string;
  }>;
  finishReason?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}): Chunk {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-test',
    ...(partial.usage ? { usage: partial.usage } : {}),
    choices:
      partial.content !== undefined || partial.toolCalls || partial.finishReason
        ? [
            {
              index: 0,
              delta: {
                ...(partial.content !== undefined
                  ? { content: partial.content }
                  : {}),
                ...(partial.toolCalls
                  ? {
                      tool_calls: partial.toolCalls.map((tc) => ({
                        index: tc.index,
                        ...(tc.id ? { id: tc.id } : {}),
                        function: {
                          ...(tc.name ? { name: tc.name } : {}),
                          ...(tc.args ? { arguments: tc.args } : {}),
                        },
                      })),
                    }
                  : {}),
              },
              finish_reason: (partial.finishReason ?? null) as never,
              logprobs: null,
            },
          ]
        : [],
  } as Chunk;
}

describe('createToolCallAccumulator', () => {
  it('passes text deltas through and captures finish_reason stop', () => {
    const acc = createToolCallAccumulator();

    expect(acc.ingest(chunk({ content: 'Hello ' }))).toBe('Hello ');
    expect(acc.ingest(chunk({ content: 'world' }))).toBe('world');
    acc.ingest(chunk({ finishReason: 'stop' }));

    expect(acc.finishReason).toBe('stop');
    expect(acc.toolCalls()).toEqual([]);
  });

  it('assembles a tool call fragmented across many chunks', () => {
    const acc = createToolCallAccumulator();

    acc.ingest(
      chunk({
        toolCalls: [{ index: 0, id: 'call_1', name: 'github__list_prs' }],
      }),
    );
    acc.ingest(chunk({ toolCalls: [{ index: 0, args: '{"re' }] }));
    acc.ingest(chunk({ toolCalls: [{ index: 0, args: 'po":"a/b"}' }] }));
    acc.ingest(chunk({ finishReason: 'tool_calls' }));

    expect(acc.finishReason).toBe('tool_calls');
    expect(acc.toolCalls()).toEqual([
      {
        id: 'call_1',
        name: 'github__list_prs',
        argumentsJson: '{"repo":"a/b"}',
      },
    ]);
  });

  it('keeps parallel tool calls separate via index keying', () => {
    const acc = createToolCallAccumulator();

    acc.ingest(
      chunk({
        toolCalls: [
          { index: 0, id: 'call_a', name: 'github__a', args: '{"x":' },
          { index: 1, id: 'call_b', name: 'asana__b' },
        ],
      }),
    );
    acc.ingest(
      chunk({
        toolCalls: [
          { index: 1, args: '{}' },
          { index: 0, args: '1}' },
        ],
      }),
    );

    expect(acc.toolCalls()).toEqual([
      { id: 'call_a', name: 'github__a', argumentsJson: '{"x":1}' },
      { id: 'call_b', name: 'asana__b', argumentsJson: '{}' },
    ]);
  });

  it('captures the trailing usage chunk (stream_options.include_usage)', () => {
    const acc = createToolCallAccumulator();

    acc.ingest(chunk({ content: 'hi', finishReason: 'stop' }));
    acc.ingest(
      chunk({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    expect(acc.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('defaults empty arguments to {} and drops id-less fragments', () => {
    const acc = createToolCallAccumulator();

    acc.ingest(
      chunk({ toolCalls: [{ index: 0, id: 'call_1', name: 'a__b' }] }),
    );
    // A stray fragment with no id/name ever arriving.
    acc.ingest(chunk({ toolCalls: [{ index: 5, args: '{"orphan":true}' }] }));

    expect(acc.toolCalls()).toEqual([
      { id: 'call_1', name: 'a__b', argumentsJson: '{}' },
    ]);
  });
});
