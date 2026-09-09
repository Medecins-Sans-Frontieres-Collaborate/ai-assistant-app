import { parseMetadataFromContent } from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';
import { parseThinkingContent } from '@/lib/utils/app/stream/thinking';

import { describe, expect, it } from 'vitest';

/**
 * Reasoning visibility: both stream processors re-emit model reasoning
 * inline wrapped in <think> tags (the format the client parses into the
 * collapsible ThinkingBlock), and also report it via terminal metadata.
 */

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

describe('createAzureOpenAIStreamProcessor — reasoning_content (DeepSeek-R1)', () => {
  async function* r1Chunks(): AsyncGenerator<any> {
    yield { choices: [{ delta: { reasoning_content: 'Let me think. ' } }] };
    yield { choices: [{ delta: { reasoning_content: 'Two plus two.' } }] };
    yield { choices: [{ delta: { content: 'The answer is 4.' } }] };
  }

  it('streams reasoning wrapped in <think> tags before the answer', async () => {
    const out = await drain(createAzureOpenAIStreamProcessor(r1Chunks()));
    const parsed = parseMetadataFromContent(out);

    expect(parsed.content).toContain(
      '<think>\nLet me think. Two plus two.\n</think>',
    );
    expect(parsed.content).toContain('The answer is 4.');
    // Reasoning precedes the answer text
    expect(parsed.content.indexOf('</think>')).toBeLessThan(
      parsed.content.indexOf('The answer is 4.'),
    );
    // And is reported via the metadata channel too
    expect(parsed.thinking).toBe('Let me think. Two plus two.');
  });

  it('closes the think block even when the stream ends mid-reasoning', async () => {
    async function* reasoningOnly(): AsyncGenerator<any> {
      yield { choices: [{ delta: { reasoning_content: 'Hmm…' } }] };
    }
    const out = await drain(createAzureOpenAIStreamProcessor(reasoningOnly()));
    const parsed = parseMetadataFromContent(out);

    expect(parsed.content).toContain('</think>');
    expect(parsed.thinking).toBe('Hmm…');
  });

  it('still reports inline <think> tags emitted directly in content', async () => {
    async function* inlineThink(): AsyncGenerator<any> {
      yield {
        choices: [{ delta: { content: '<think>step one</think>Answer.' } }],
      };
    }
    const out = await drain(createAzureOpenAIStreamProcessor(inlineThink()));
    const parsed = parseMetadataFromContent(out);

    expect(parsed.content).toContain('<think>step one</think>');
    expect(parsed.thinking).toBe('step one');
  });
});

describe('createAnthropicStreamProcessor — extended thinking', () => {
  async function* claudeEvents(): AsyncGenerator<any> {
    yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
    yield {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Considering the ' },
    };
    yield {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'question…' },
    };
    yield {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Here is my answer.' },
    };
  }

  it('streams thinking deltas live wrapped in <think> tags', async () => {
    const out = await drain(createAnthropicStreamProcessor(claudeEvents()));
    const parsed = parseMetadataFromContent(out);

    expect(parsed.content).toContain(
      '<think>\nConsidering the question…\n</think>',
    );
    expect(parsed.content).toContain('Here is my answer.');
    expect(parsed.content.indexOf('</think>')).toBeLessThan(
      parsed.content.indexOf('Here is my answer.'),
    );
    expect(parsed.thinking).toBe('Considering the question…');
  });

  it('closes the wrapper on a thinking-only stream', async () => {
    async function* thinkingOnly(): AsyncGenerator<any> {
      yield {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'still thinking' },
      };
    }
    const out = await drain(createAnthropicStreamProcessor(thinkingOnly()));
    expect(parseMetadataFromContent(out).content).toContain('</think>');
  });
});

describe('parseThinkingContent — unclosed blocks (streaming)', () => {
  it('routes an unclosed <think> block into thinking with includeUnclosed', () => {
    const result = parseThinkingContent('<think>\nreasoning so far', {
      includeUnclosed: true,
    });

    expect(result.thinking).toBe('reasoning so far');
    expect(result.content).toBe('');
    expect(result.thinkingInProgress).toBe(true);
  });

  it('combines closed and unclosed blocks in order', () => {
    const result = parseThinkingContent(
      '<think>first</think>Answer text<think>more', // second block still open
      { includeUnclosed: true },
    );

    expect(result.thinking).toBe('first\n\n---\n\nmore');
    expect(result.content).toBe('Answer text');
    expect(result.thinkingInProgress).toBe(true);
  });

  it('leaves an unclosed tag alone WITHOUT includeUnclosed (persisted parse)', () => {
    const text = 'I typed a literal <think> tag in prose';
    const result = parseThinkingContent(text);

    expect(result.thinking).toBeUndefined();
    expect(result.content).toBe(text);
  });

  it('reports thinkingInProgress with empty thinking when only the open tag arrived', () => {
    const result = parseThinkingContent('<think>', { includeUnclosed: true });

    expect(result.thinking).toBeUndefined();
    expect(result.content).toBe('');
    expect(result.thinkingInProgress).toBe(true);
  });

  it('keeps closed-block behavior unchanged', () => {
    const result = parseThinkingContent('<think>steps</think>The answer.');

    expect(result.thinking).toBe('steps');
    expect(result.content).toBe('The answer.');
  });
});
