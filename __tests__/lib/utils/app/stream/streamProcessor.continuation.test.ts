import { StreamContinuation } from '@/lib/services/chat/streamContinuation';

import { parseMetadataFromContent } from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import { createResponsesStreamProcessor } from '@/lib/utils/app/stream/responsesStreamProcessor';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';

import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mid-answer recovery in the three stream processors: an output-limit
 * finish or an upstream failure AFTER text reached the client reopens the
 * stream through the continuation hook and keeps appending; a content
 * filter ends the turn with its own in-band error; nothing changes when
 * no hook is supplied.
 */

async function drain(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** Visible text only: strips loader markers and the terminal metadata block. */
function visible(text: string): string {
  return text
    .replace(/<<<AGENT_ACTIVITY>>>[\s\S]*?<<<END_AGENT_ACTIVITY>>>/g, '')
    .replace(/<<<METADATA_START>>>[\s\S]*?<<<METADATA_END>>>/g, '')
    .replace(/\n\n/g, '');
}

async function* gen<T>(items: T[], failWith?: Error): AsyncGenerator<T> {
  for (const item of items) yield item;
  if (failWith) throw failWith;
}

const openAIChunk = (
  content: string | null,
  finish: string | null = null,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
): OpenAI.Chat.Completions.ChatCompletionChunk =>
  ({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt',
    choices:
      content === null && finish === null
        ? []
        : [
            {
              index: 0,
              delta: content === null ? {} : { content },
              finish_reason: finish,
            },
          ],
    ...(usage ? { usage } : {}),
  }) as OpenAI.Chat.Completions.ChatCompletionChunk;

describe('createAzureOpenAIStreamProcessor continuation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('continues after a length finish and sums usage across rounds', async () => {
    const resume = vi.fn<
      StreamContinuation<OpenAI.Chat.Completions.ChatCompletionChunk>['resume']
    >(async (partial, reason) => {
      expect(partial).toBe('Part one ');
      expect(reason).toBe('length');
      return gen([
        openAIChunk('and part two.', 'stop'),
        openAIChunk(null, null, {
          prompt_tokens: 50,
          completion_tokens: 5,
          total_tokens: 55,
        }),
      ]);
    });
    const onUsage = vi.fn();
    const stream = createAzureOpenAIStreamProcessor(
      gen([
        openAIChunk('Part one ', 'length'),
        openAIChunk(null, null, {
          prompt_tokens: 40,
          completion_tokens: 10,
          total_tokens: 50,
        }),
      ]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { modelId: 'gpt', region: 'US', onUsage },
      { continuation: { resume } },
    );
    const text = await drain(stream);
    expect(visible(text)).toContain('Part one and part two.');
    expect(text).toContain('chat.activity.continuingResponse');
    const parsed = parseMetadataFromContent(text);
    expect(parsed.streamError).toBeUndefined();
    expect(parsed.usage).toMatchObject({
      promptTokens: 90,
      completionTokens: 15,
      totalTokens: 105,
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('resumes after an upstream failure once text has streamed, within the cap', async () => {
    let resumes = 0;
    const resume: StreamContinuation<OpenAI.Chat.Completions.ChatCompletionChunk>['resume'] =
      async (_partial, reason) => {
        expect(reason).toBe('interrupted');
        resumes += 1;
        return gen([openAIChunk(` resumed${resumes}`, 'stop')]);
      };
    const stream = createAzureOpenAIStreamProcessor(
      gen(
        [openAIChunk('Hello')],
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      ),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { continuation: { resume } },
    );
    const text = await drain(stream);
    expect(visible(text)).toContain('Hello resumed1');
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
  });

  it('declines to resume a non-retryable failure and reports its cause', async () => {
    const resume = vi.fn();
    const stream = createAzureOpenAIStreamProcessor(
      gen(
        [openAIChunk('Hello')],
        Object.assign(new Error('context_length_exceeded'), {
          status: 400,
          code: 'context_length_exceeded',
        }),
      ),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { continuation: { resume } },
    );
    const parsed = parseMetadataFromContent(await drain(stream));
    expect(resume).not.toHaveBeenCalled();
    expect(parsed.streamError).toMatchObject({
      code: 'MODEL_CONTEXT_TOO_LONG',
      kind: 'context_overflow',
    });
    expect(parsed.streamError?.retry).toBeUndefined();
  });

  it('flags retry when a retryable failure left no text and no hook exists', async () => {
    const stream = createAzureOpenAIStreamProcessor(
      gen([], Object.assign(new Error('upstream'), { status: 502 })),
    );
    const parsed = parseMetadataFromContent(await drain(stream));
    expect(parsed.streamError).toMatchObject({
      code: 'UPSTREAM_STREAM_FAILED',
      kind: 'provider_internal',
      retry: true,
    });
  });

  it('ends with a content-filter error on finish_reason content_filter', async () => {
    const stream = createAzureOpenAIStreamProcessor(
      gen([openAIChunk('I was going to', 'content_filter')]),
    );
    const parsed = parseMetadataFromContent(await drain(stream));
    expect(parsed.streamError).toMatchObject({
      code: 'MODEL_CONTENT_FILTERED',
      kind: 'content_filter',
    });
  });

  it('reports an output limit with no text as MODEL_OUTPUT_LIMIT instead of continuing', async () => {
    const resume = vi.fn();
    const stream = createAzureOpenAIStreamProcessor(
      gen([openAIChunk(null, 'length')]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { continuation: { resume } },
    );
    const parsed = parseMetadataFromContent(await drain(stream));
    expect(resume).not.toHaveBeenCalled();
    expect(parsed.streamError?.code).toBe('MODEL_OUTPUT_LIMIT');
  });
});

const anthropicText = (text: string): Anthropic.RawMessageStreamEvent =>
  ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }) as Anthropic.RawMessageStreamEvent;
const anthropicStop = (
  reason: string,
  output = 1,
): Anthropic.RawMessageStreamEvent =>
  ({
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: output },
  }) as Anthropic.RawMessageStreamEvent;

describe('createAnthropicStreamProcessor continuation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('continues after max_tokens and stops at the continuation cap', async () => {
    const resume = vi.fn(async () =>
      gen([anthropicText(' more'), anthropicStop('max_tokens', 2)]),
    );
    const stream = createAnthropicStreamProcessor(
      gen([anthropicText('Start'), anthropicStop('max_tokens', 3)]),
      undefined,
      undefined,
      undefined,
      undefined,
      { continuation: { resume, maxOutputLimitContinuations: 2 } },
    );
    const text = await drain(stream);
    expect(visible(text)).toContain('Start more more');
    expect(resume).toHaveBeenCalledTimes(2);
    // Cap reached with text present: the partial stands, no error.
    expect(parseMetadataFromContent(text).streamError).toBeUndefined();
  });

  it('maps a refusal stop to the content-filter error', async () => {
    const stream = createAnthropicStreamProcessor(
      gen([anthropicStop('refusal')]),
    );
    const parsed = parseMetadataFromContent(await drain(stream));
    expect(parsed.streamError?.code).toBe('MODEL_CONTENT_FILTERED');
  });
});

describe('createResponsesStreamProcessor continuation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const delta = (text: string): OpenAI.Responses.ResponseStreamEvent =>
    ({
      type: 'response.output_text.delta',
      delta: text,
      item_id: 'i',
      output_index: 0,
      content_index: 0,
      sequence_number: 0,
    }) as OpenAI.Responses.ResponseStreamEvent;
  const incomplete = (reason: string): OpenAI.Responses.ResponseStreamEvent =>
    ({
      type: 'response.incomplete',
      sequence_number: 1,
      response: {
        id: 'r',
        status: 'incomplete',
        incomplete_details: { reason },
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    }) as unknown as OpenAI.Responses.ResponseStreamEvent;
  const completed = (): OpenAI.Responses.ResponseStreamEvent =>
    ({
      type: 'response.completed',
      sequence_number: 2,
      response: {
        id: 'r2',
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 },
      },
    }) as unknown as OpenAI.Responses.ResponseStreamEvent;

  it('continues after response.incomplete max_output_tokens', async () => {
    const resume = vi.fn(async () => gen([delta(' two'), completed()]));
    const onUsage = vi.fn();
    const stream = createResponsesStreamProcessor(
      gen([delta('one'), incomplete('max_output_tokens')]),
      undefined,
      undefined,
      undefined,
      { modelId: 'gpt', region: 'US', onUsage },
      undefined,
      undefined,
      { resume },
    );
    const text = await drain(stream);
    expect(visible(text)).toContain('one two');
    const parsed = parseMetadataFromContent(text);
    expect(parsed.streamError).toBeUndefined();
    expect(parsed.usage).toMatchObject({
      promptTokens: 30,
      completionTokens: 12,
    });
  });

  it('ends with a content-filter error on response.incomplete content_filter', async () => {
    const stream = createResponsesStreamProcessor(
      gen([delta('one'), incomplete('content_filter')]),
    );
    const parsed = parseMetadataFromContent(await drain(stream));
    expect(parsed.streamError?.code).toBe('MODEL_CONTENT_FILTERED');
  });
});
