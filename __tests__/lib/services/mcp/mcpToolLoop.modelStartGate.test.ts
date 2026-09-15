import { runAnthropicMcpToolLoop } from '@/lib/services/mcp/AnthropicMcpToolLoopService';
import { runMcpToolLoop } from '@/lib/services/mcp/McpToolLoopService';

import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

/**
 * End-to-end shape of the model-start gate through both provider loops: the
 * loop's Response — the thing the pipeline stage timer races — must not
 * appear before the provider's request promise resolves, and must appear
 * as soon as it does, before a single chunk is consumed.
 */

function settledOrPending<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'))),
  ]);
}

/** An async iterable that never yields — a model that opened but hangs. */
const neverEnding = {
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<never>(() => {}) };
  },
};

const usage = { modelId: 'test', region: null as null, onUsage: vi.fn() };

describe('OpenAI MCP loop model-start gate', () => {
  it('returns no Response while the model request is unanswered, then one as soon as it resolves', async () => {
    let openStream!: () => void;
    const handler = {
      executeRequest: vi.fn(
        () =>
          new Promise((resolve) => {
            openStream = () => resolve(neverEnding);
          }),
      ),
    };

    const pending = runMcpToolLoop({
      handler: handler as never,
      preparedMessages: [
        { role: 'user', content: 'hi' },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      buildParams: (messages) =>
        ({
          model: 'gpt-test',
          messages,
          stream: true,
        }) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      servers: [],
      loopRound: 0,
      userId: 'user-1',
      usage,
    });

    expect(await settledOrPending(pending)).toBe('pending');
    expect(handler.executeRequest).toHaveBeenCalledTimes(1);

    openStream();
    expect(await pending).toBeInstanceOf(Response);
  });
});

describe('Anthropic MCP loop model-start gate', () => {
  it('returns no Response while the model request is unanswered, then one as soon as it resolves', async () => {
    let openStream!: () => void;
    const handler = {
      executeStreamingRequest: vi.fn(
        () =>
          new Promise((resolve) => {
            openStream = () => resolve(neverEnding);
          }),
      ),
    };

    const pending = runAnthropicMcpToolLoop({
      handler: handler as never,
      preparedMessages: [
        { role: 'user', content: 'hi' },
      ] as Anthropic.MessageParam[],
      buildParams: (messages) =>
        ({
          model: 'claude-test',
          messages,
          max_tokens: 100,
          stream: true,
        }) as Anthropic.MessageCreateParamsStreaming,
      servers: [],
      loopRound: 0,
      userId: 'user-1',
      usage,
    });

    expect(await settledOrPending(pending)).toBe('pending');
    expect(handler.executeStreamingRequest).toHaveBeenCalledTimes(1);

    openStream();
    expect(await pending).toBeInstanceOf(Response);
  });
});
