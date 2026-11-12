/**
 * The shared helper-model path: chain first, the caller's chat-model
 * fallback second, never after cancellation, and the original auxiliary
 * error when everything fails.
 */
import { AuxiliaryUnavailableError } from '@/lib/services/auxiliary/AuxiliaryModelExecutor';
import {
  AuxiliaryCompletionService,
  parseJsonReply,
} from '@/lib/services/auxiliary/auxiliaryCompletion';

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

const params: Params = {
  model: '',
  messages: [{ role: 'user', content: 'classify' }],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'verdict', strict: true, schema: {} },
  },
};

const acceptOk = (response: OpenAI.Chat.Completions.ChatCompletion) => {
  const value = parseJsonReply(response) as { ok?: boolean } | undefined;
  return typeof value?.ok === 'boolean' ? value.ok : undefined;
};

/** An executor stub: `execute` runs the given implementation. */
function executorWith(
  execute: (
    params: Params,
    accept: (response: OpenAI.Chat.Completions.ChatCompletion) => unknown,
    options: {
      region: string;
      operation: string;
      timeoutMs: number;
      onUsage?: (response: unknown, candidate: unknown) => void;
    },
  ) => Promise<unknown>,
) {
  return { execute: vi.fn(execute) } as never;
}

const failing = (reason: 'residency' | 'timeout' = 'residency') =>
  executorWith(async () => {
    throw new AuxiliaryUnavailableError(reason, 'EU');
  });

function structuredFallback(text: string) {
  return vi.fn(async () => ({
    text,
    model: { id: 'mistral-large' } as never,
    region: 'EU' as const,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  }));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('AuxiliaryCompletionService.completeJson', () => {
  it('answers on the chain with the routed operation and region', async () => {
    const executor = executorWith(async (_params, accept) =>
      accept({ choices: [{ message: { content: '{"ok":true}' } }] } as never),
    );
    const answer = await new AuxiliaryCompletionService(executor).completeJson({
      operation: 'mailScreen',
      region: 'US',
      params,
      accept: acceptOk,
      timeoutMs: 1000,
    });
    expect(answer).toEqual({ value: true, source: 'auxiliary' });
    expect((executor as any).execute.mock.calls[0][2]).toMatchObject({
      operation: 'mailScreen',
      region: 'US',
      timeoutMs: 1000,
    });
  });

  it('maps chain usage to the serving region and model', async () => {
    const onUsage = vi.fn();
    const executor = executorWith(async (_params, accept, options) => {
      const response = {
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      };
      options.onUsage?.(response, {
        reference: { accountBinding: 'EU' },
        deployment: { modelName: 'gpt-5.4-mini' },
        model: { id: 'gpt-5.4-mini' },
      });
      return accept(response as never);
    });
    await new AuxiliaryCompletionService(executor).completeJson({
      operation: 'mcpPlan',
      region: 'EU',
      params,
      accept: acceptOk,
      timeoutMs: 1000,
      onUsage,
    });
    expect(onUsage).toHaveBeenCalledWith(
      {
        modelId: 'gpt-5.4-mini',
        region: 'EU',
        promptTokens: 5,
        completionTokens: 1,
        totalTokens: 6,
      },
      { id: 'gpt-5.4-mini' },
      'EU',
    );
  });

  it('falls back to the chat model, held to the same acceptance, with its usage', async () => {
    const fallback = structuredFallback('{"ok":false}');
    const onUsage = vi.fn();
    const answer = await new AuxiliaryCompletionService(failing()).completeJson(
      {
        operation: 'schemaProposal',
        region: 'EU',
        params,
        accept: acceptOk,
        timeoutMs: 1000,
        onUsage,
        fallback,
      },
    );
    expect(answer).toEqual({
      value: false,
      source: 'chat_model',
      model: 'mistral-large',
    });
    expect(fallback.mock.calls[0][0]).toBe(params);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'mistral-large', totalTokens: 12 }),
      { id: 'mistral-large' },
      'EU',
    );
  });

  it('rethrows the original auxiliary error when the fallback reply is invalid', async () => {
    await expect(
      new AuxiliaryCompletionService(failing('residency')).completeJson({
        operation: 'tools',
        region: 'EU',
        params,
        accept: acceptOk,
        timeoutMs: 1000,
        fallback: structuredFallback('{"unrelated":1}'),
      }),
    ).rejects.toMatchObject({ reason: 'residency' });
  });

  it('never falls back after the caller cancels', async () => {
    const controller = new AbortController();
    const executor = executorWith(async () => {
      controller.abort();
      throw new AuxiliaryUnavailableError('timeout', 'EU');
    });
    const fallback = structuredFallback('{"ok":true}');
    await expect(
      new AuxiliaryCompletionService(executor).completeJson({
        operation: 'tools',
        region: 'EU',
        params,
        accept: acceptOk,
        timeoutMs: 1000,
        signal: controller.signal,
        fallback,
      }),
    ).rejects.toBeInstanceOf(AuxiliaryUnavailableError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('shares one deadline unless the caller gives the fallback its own budget', async () => {
    vi.useFakeTimers();
    try {
      const slowFailure = executorWith(async (_p, _a, options) => {
        vi.advanceTimersByTime(options.timeoutMs);
        throw new AuxiliaryUnavailableError('timeout', 'EU');
      });
      const shared = structuredFallback('{"ok":true}');
      await expect(
        new AuxiliaryCompletionService(slowFailure).completeJson({
          operation: 'tools',
          region: 'EU',
          params,
          accept: acceptOk,
          timeoutMs: 100,
          fallback: shared,
        }),
      ).rejects.toBeInstanceOf(AuxiliaryUnavailableError);
      expect(shared).not.toHaveBeenCalled();

      const ownBudget = structuredFallback('{"ok":true}');
      const answer = await new AuxiliaryCompletionService(
        slowFailure,
      ).completeJson({
        operation: 'tools',
        region: 'EU',
        params,
        accept: acceptOk,
        timeoutMs: 100,
        fallbackTimeoutMs: 5000,
        fallback: ownBudget,
      });
      expect(answer.source).toBe('chat_model');
    } finally {
      vi.useRealTimers();
    }
  });

  it('without an executor or direct client, reports the chain as missing', async () => {
    await expect(
      new AuxiliaryCompletionService().completeJson({
        operation: 'mailAnalysis',
        region: 'EU',
        params,
        accept: acceptOk,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ reason: 'endpoint_missing' });
  });

  it('rejects an unacceptable direct-client reply as incompatible', async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: 'nope' } }],
    }));
    const service = new AuxiliaryCompletionService(
      undefined,
      () => ({ chat: { completions: { create } } }) as never,
    );
    await expect(
      service.completeJson({
        operation: 'mailAnalysis',
        region: 'EU',
        params,
        accept: acceptOk,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ reason: 'incompatible' });
    expect(create.mock.calls[0][1]).toMatchObject({
      maxRetries: 0,
      timeout: 1000,
    });
  });
});

describe('AuxiliaryCompletionService.completeText', () => {
  it('sends the prompts on the chain and accepts plain text', async () => {
    const executor = executorWith(async (sent, accept) => {
      expect(sent.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ]);
      expect(sent.max_completion_tokens).toBe(50);
      return accept({ choices: [{ message: { content: ' q ' } }] } as never);
    });
    const answer = await new AuxiliaryCompletionService(executor).completeText({
      operation: 'query',
      region: 'EU',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxTokens: 50,
      timeoutMs: 1000,
      accept: (text) => text?.trim() || undefined,
    });
    expect(answer).toEqual({ value: 'q', source: 'auxiliary' });
  });

  it('gives the text fallback its own token budget and minimal effort', async () => {
    const fallback = vi.fn(async () => 'rewritten');
    const answer = await new AuxiliaryCompletionService(failing()).completeText(
      {
        operation: 'query',
        region: 'EU',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        maxTokens: 50,
        fallbackMaxTokens: 900,
        timeoutMs: 1000,
        accept: (text) => text?.trim() || undefined,
        fallback,
      },
    );
    expect(answer).toEqual({ value: 'rewritten', source: 'chat_model' });
    expect(fallback.mock.calls[0][0]).toEqual({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxTokens: 900,
      reasoningEffort: 'minimal',
    });
  });
});
