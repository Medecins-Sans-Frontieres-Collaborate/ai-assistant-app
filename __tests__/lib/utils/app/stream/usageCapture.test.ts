import { parseMetadataFromContent } from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import {
  UsageContext,
  createAzureOpenAIStreamProcessor,
} from '@/lib/utils/app/stream/streamProcessor';

import { describe, expect, it } from 'vitest';

async function drain(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function* openAIChunks(): AsyncGenerator<any> {
  yield { choices: [{ delta: { content: 'Hello' } }] };
  yield { choices: [{ delta: { content: ' world' } }] };
  // Terminal usage chunk: empty choices, populated usage.
  yield {
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  };
}

describe('createAzureOpenAIStreamProcessor — usage capture', () => {
  it('captures the terminal usage chunk into metadata + onUsage', async () => {
    let reported: unknown;
    const usageContext: UsageContext = {
      modelId: 'gpt-5.2',
      region: 'EU',
      reasoningEffort: 'medium',
      onUsage: (u) => {
        reported = u;
      },
    };
    const out = await drain(
      createAzureOpenAIStreamProcessor(
        openAIChunks(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        usageContext,
      ),
    );
    const parsed = parseMetadataFromContent(out);
    expect(parsed.content).toBe('Hello world');
    expect(parsed.usage).toEqual({
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
      modelId: 'gpt-5.2',
      region: 'EU',
      reasoningEffort: 'medium',
    });
    expect(reported).toEqual(parsed.usage);
  });

  it('emits NO usage metadata when no usageContext is passed', async () => {
    const out = await drain(createAzureOpenAIStreamProcessor(openAIChunks()));
    expect(parseMetadataFromContent(out).usage).toBeUndefined();
  });
});

async function* anthropicEvents(): AsyncGenerator<any> {
  yield { type: 'message_start', message: { usage: { input_tokens: 50 } } };
  yield {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'Hi' },
  };
  // message_delta usage is cumulative; the last value wins.
  yield { type: 'message_delta', usage: { output_tokens: 10 } };
  yield { type: 'message_delta', usage: { output_tokens: 25 } };
}

describe('createAnthropicStreamProcessor — usage capture', () => {
  it('captures message_start + cumulative message_delta usage', async () => {
    let reported: unknown;
    const out = await drain(
      createAnthropicStreamProcessor(
        anthropicEvents(),
        undefined,
        undefined,
        undefined,
        {
          modelId: 'claude-opus-4-8',
          region: 'US',
          onUsage: (u) => {
            reported = u;
          },
        },
      ),
    );
    const parsed = parseMetadataFromContent(out);
    expect(parsed.content).toBe('Hi');
    expect(parsed.usage).toEqual({
      promptTokens: 50,
      completionTokens: 25,
      totalTokens: 75,
      modelId: 'claude-opus-4-8',
      region: 'US',
      reasoningEffort: undefined,
    });
    expect(reported).toEqual(parsed.usage);
  });
});
