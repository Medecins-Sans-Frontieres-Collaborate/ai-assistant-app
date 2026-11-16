/**
 * Knowledge-base query rewrites under the user's residency: the auxiliary
 * `query` operation first, the user's chat model second, the raw question
 * last, all inside one shared deadline.
 */
import { AuxiliaryUnavailableError } from '@/lib/services/auxiliary/AuxiliaryModelExecutor';
import { AuxiliaryCompletionService } from '@/lib/services/auxiliary/auxiliaryCompletion';
import {
  MAX_REFORMULATED_QUERY_CHARS,
  QUERY_REFORMULATION_FALLBACK_MAX_TOKENS,
  QueryReformulator,
  REWRITE_HISTORY_TURNS,
  REWRITE_HISTORY_TURN_CHARS,
  acceptReformulatedQuery,
  buildKnowledgeBaseReformulationPrompt,
  latestUserQuestion,
  messageText,
  queryReformulationRequest,
  rewriteConversationHistory,
} from '@/lib/services/search/queryReformulation';

import type { Message } from '@/types/chat';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = { systemPrompt: 'Rewrite.', userPrompt: 'latest Gaza news' };

/** An executor double: `execute` runs the caller's validator on `reply`. */
function executorReturning(reply: string) {
  return {
    execute: vi.fn(async (_params, validate, options) => {
      const response = {
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
      };
      options.onUsage?.(response, {
        reference: { accountBinding: 'EU', deploymentName: 'luna' },
        deployment: { modelName: 'gpt-5.6-luna' },
        model: { id: 'gpt-5.6-luna' },
      });
      const value = validate(response);
      if (value === undefined)
        throw new AuxiliaryUnavailableError('incompatible', options.region);
      return value;
    }),
  };
}

function executorFailing(reason: 'residency' | 'timeout' = 'residency') {
  return {
    execute: vi.fn(async (_params, _validate, options) => {
      throw new AuxiliaryUnavailableError(reason, options.region);
    }),
  };
}

describe('QueryReformulator', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs the auxiliary query operation in the routed region', async () => {
    const executor = executorReturning('Gaza humanitarian news November 2026');
    const onUsage = vi.fn();
    const fallback = vi.fn();

    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executor as never),
    ).reformulate(prompt, { region: 'EU', textFallback: fallback, onUsage });

    expect(result).toEqual({
      query: 'Gaza humanitarian news November 2026',
      source: 'auxiliary',
    });
    const [params, , options] = executor.execute.mock.calls[0];
    expect(params).toEqual(queryReformulationRequest(prompt));
    expect(options).toMatchObject({ region: 'EU', operation: 'query' });
    expect(options.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.6-luna', totalTokens: 46 }),
      expect.objectContaining({ id: 'gpt-5.6-luna' }),
      'EU',
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the user's chat model when no eligible auxiliary model answers", async () => {
    const fallback = vi.fn(async () => 'Gaza news November 2026');

    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executorFailing('residency') as never),
    ).reformulate(prompt, { region: 'EU', textFallback: fallback });

    expect(result).toEqual({
      query: 'Gaza news November 2026',
      source: 'chat_model',
    });
    const [request, signal] = fallback.mock.calls[0] as unknown as [
      Record<string, unknown>,
      AbortSignal,
    ];
    expect(request).toEqual({
      systemPrompt: 'Rewrite.',
      userPrompt: 'latest Gaza news',
      maxTokens: QUERY_REFORMULATION_FALLBACK_MAX_TOKENS,
      reasoningEffort: 'minimal',
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('goes straight to the chat model when no executor is wired', async () => {
    const fallback = vi.fn(async () => 'query');
    const result = await new QueryReformulator().reformulate(prompt, {
      region: 'US',
      textFallback: fallback,
    });
    expect(result?.source).toBe('chat_model');
  });

  it('returns undefined (raw question) when every path fails', async () => {
    const fallback = vi.fn(async () => {
      throw new Error('429');
    });
    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executorFailing() as never),
    ).reformulate(prompt, { region: 'EU', textFallback: fallback });
    expect(result).toBeUndefined();
  });

  it('returns undefined when the auxiliary chain fails and there is no fallback', async () => {
    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executorFailing() as never),
    ).reformulate(prompt, { region: 'EU' });
    expect(result).toBeUndefined();
  });

  it('rejects a chat-model reply that answers instead of rewriting', async () => {
    const fallback = vi.fn(async () =>
      'x'.repeat(MAX_REFORMULATED_QUERY_CHARS + 1),
    );
    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executorFailing() as never),
    ).reformulate(prompt, { region: 'EU', textFallback: fallback });
    expect(result).toBeUndefined();
  });

  it('shares one deadline: a timed-out auxiliary chain leaves no time for the fallback', async () => {
    const executor = {
      execute: vi.fn(
        // Like the real executor: gives up when its timeoutMs runs out.
        (_params, _validate, options) =>
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new AuxiliaryUnavailableError('timeout', 'EU')),
              options.timeoutMs,
            ),
          ),
      ),
    };
    const fallback = vi.fn(async () => 'too late');

    const started = Date.now();
    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executor as never),
      50,
    ).reformulate(prompt, { region: 'EU', textFallback: fallback });

    expect(result).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not try the fallback after the caller cancels', async () => {
    const caller = new AbortController();
    const executor = {
      execute: vi.fn(async (_params, _validate, options) => {
        caller.abort();
        throw new AuxiliaryUnavailableError('timeout', options.region);
      }),
    };
    const fallback = vi.fn(async () => 'query');

    const result = await new QueryReformulator(
      new AuxiliaryCompletionService(executor as never),
    ).reformulate(prompt, {
      region: 'EU',
      textFallback: fallback,
      signal: caller.signal,
    });

    expect(result).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('acceptReformulatedQuery', () => {
  it('trims and strips wrapping quotes', () => {
    expect(acceptReformulatedQuery('  "MSF Sudan 2026"  ')).toBe(
      'MSF Sudan 2026',
    );
  });

  it.each([null, undefined, '', '   ', '""'])('rejects %j', (reply) => {
    expect(acceptReformulatedQuery(reply)).toBeUndefined();
  });

  it('accepts exactly the length limit and rejects one over it', () => {
    const atLimit = 'q'.repeat(MAX_REFORMULATED_QUERY_CHARS);
    expect(acceptReformulatedQuery(atLimit)).toBe(atLimit);
    expect(acceptReformulatedQuery(`${atLimit}q`)).toBeUndefined();
  });
});

describe('buildKnowledgeBaseReformulationPrompt', () => {
  it('turns relative dates into the current and previous month', () => {
    const { systemPrompt, userPrompt } = buildKnowledgeBaseReformulationPrompt(
      'user: what happened last month?',
      'what happened last month?',
      new Date(2026, 0, 15),
    );
    expect(systemPrompt).toContain('Today is January 15, 2026');
    expect(systemPrompt).toContain('"December 2025"');
    expect(userPrompt).toContain('Original query: what happened last month?');
  });
});

describe('messageText', () => {
  it('reads a plain string', () => {
    expect(messageText('  hello  ')).toBe('hello');
  });

  it('keeps the question asked alongside an attachment', () => {
    expect(
      messageText([
        { type: 'text', text: 'What does the memo say?' },
        { type: 'file_url', url: 'https://blob/x.txt' },
      ] as Message['content']),
    ).toBe('What does the memo say?');
  });

  it('reads a single text part and ignores non-text parts', () => {
    expect(
      messageText({ type: 'text', text: 'hi' } as Message['content']),
    ).toBe('hi');
    expect(
      messageText([
        { type: 'image_url', image_url: { url: 'x' } },
      ] as Message['content']),
    ).toBe('');
  });
});

describe('latestUserQuestion', () => {
  it('returns the last user turn, skipping later assistant turns', () => {
    const messages = [
      { role: 'user', content: 'first' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'second' },
          { type: 'file_url', url: 'u' },
        ],
      },
      { role: 'assistant', content: 'answer' },
    ] as Message[];
    expect(latestUserQuestion(messages)).toBe('second');
  });

  it('is empty when there is no user turn', () => {
    expect(latestUserQuestion([])).toBe('');
  });
});

describe('rewriteConversationHistory', () => {
  it('leaves out system messages carrying inlined documents', () => {
    const history = rewriteConversationHistory([
      {
        role: 'system',
        content: 'The user has uploaded: ' + 'x'.repeat(50_000),
      },
      { role: 'user', content: 'Summarize the memo' },
    ] as Message[]);
    expect(history).toBe('user: Summarize the memo');
  });

  it(`keeps only the last ${REWRITE_HISTORY_TURNS} turns`, () => {
    const turns = Array.from({ length: REWRITE_HISTORY_TURNS + 3 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn ${i}`,
    })) as Message[];
    const lines = rewriteConversationHistory(turns).split('\n');
    expect(lines).toHaveLength(REWRITE_HISTORY_TURNS);
    expect(lines.at(-1)).toContain(`turn ${REWRITE_HISTORY_TURNS + 2}`);
  });

  it('caps a long turn and marks an attachment-only turn', () => {
    const history = rewriteConversationHistory([
      {
        role: 'assistant',
        content: 'y'.repeat(REWRITE_HISTORY_TURN_CHARS + 50),
      },
      { role: 'user', content: [{ type: 'file_url', url: 'u' }] },
    ] as Message[]).split('\n');
    expect(history[0]).toBe(
      `assistant: ${'y'.repeat(REWRITE_HISTORY_TURN_CHARS)}…`,
    );
    expect(history[1]).toBe('user: [attachment]');
  });
});
