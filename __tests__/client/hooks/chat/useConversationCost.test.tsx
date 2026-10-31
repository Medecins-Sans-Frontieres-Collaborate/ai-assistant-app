import { renderHook } from '@testing-library/react';

import { useConversationCost } from '@/client/hooks/chat/useConversationCost';

import { AssistantMessageGroup, Conversation, Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

const text = (tokens: number) => 'a'.repeat(tokens * 4);

const user = (tokens: number): Message => ({
  role: 'user',
  content: text(tokens),
  messageType: 'TEXT',
});

const measured = (
  modelId: string,
  createdAt: string,
  effort?: 'high' | 'low',
): AssistantMessageGroup => ({
  type: 'assistant_group',
  activeIndex: 0,
  versions: [
    {
      content: text(20),
      messageType: 'TEXT',
      createdAt,
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        modelId,
        region: null,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    },
  ],
});

const untracked: Message = {
  role: 'assistant',
  content: text(50),
  messageType: 'TEXT',
};

const conversation = (
  messages: Conversation['messages'],
  extra?: Partial<Conversation>,
): Conversation => ({
  id: 'c1',
  name: 'test',
  messages,
  model: { id: 'priced', name: 'Priced' } as OpenAIModel,
  prompt: '',
  temperature: 0.5,
  folderId: null,
  ...extra,
});

// $10 / $30 per 1M → one 1000/500 request = $0.025.
const priced = {
  id: 'priced',
  name: 'Priced',
  pricing: { inputPer1M: 10, outputPer1M: 30 },
} as OpenAIModel;
const reasoner = {
  id: 'thinker',
  name: 'Thinker',
  modelType: 'reasoning',
  pricing: { inputPer1M: 10, outputPer1M: 30 },
} as OpenAIModel;
const tunable = {
  id: 'tunable',
  name: 'Tunable',
  supportsReasoningEffort: true,
  pricing: { inputPer1M: 10, outputPer1M: 30 },
} as OpenAIModel;

const OLD = '2020-01-01T00:00:00.000Z';

describe('useConversationCost', () => {
  beforeEach(() => {
    useSettingsStore.setState({ models: [priced, reasoner, tunable] });
  });

  it('prices measured requests at list rates and splits today from all time', () => {
    const now = new Date().toISOString();
    const { result } = renderHook(() =>
      useConversationCost(
        conversation([
          user(10),
          measured('priced', OLD),
          user(10),
          measured('priced', now),
        ]),
      ),
    );
    expect(result.current).toMatchObject({
      requests: 2,
      pricedRequests: 2,
      unpricedRequests: 0,
      todayRequests: 1,
      hasEstimated: false,
    });
    expect(result.current!.totalUsd).toBeCloseTo(0.05, 6);
    expect(result.current!.measuredUsd).toBeCloseTo(0.05, 6);
    expect(result.current!.todayUsd).toBeCloseTo(0.025, 6);
    expect(result.current!.lastRequestUsd).toBeCloseTo(0.025, 6);
  });

  it('stands in for invisible reasoning tokens with the estimator output multipliers', () => {
    const { result } = renderHook(() =>
      useConversationCost(
        conversation([
          user(10),
          measured('thinker', OLD), // dedicated reasoner: output ×3
          user(10),
          measured('tunable', OLD, 'high'), // high effort: output ×2
          user(10),
          measured('tunable', OLD, 'low'), // ×1
        ]),
      ),
    );
    // 0.01 + 0.045, 0.01 + 0.03, 0.01 + 0.015
    expect(result.current!.totalUsd).toBeCloseTo(0.055 + 0.04 + 0.025, 6);
  });

  it('counts requests without a list price separately instead of pricing them at zero', () => {
    const { result } = renderHook(() =>
      useConversationCost(
        conversation([
          user(10),
          measured('priced', OLD),
          user(10),
          measured('byom-mine', OLD),
          user(10),
          measured('never-heard-of', OLD),
        ]),
      ),
    );
    expect(result.current).toMatchObject({
      requests: 3,
      pricedRequests: 1,
      unpricedRequests: 2,
    });
    expect(result.current!.totalUsd).toBeCloseTo(0.025, 6);
    // The last PRICED request, not the last request.
    expect(result.current!.lastRequestUsd).toBeCloseTo(0.025, 6);
  });

  it('back-calculates untracked turns at the conversation model and labels them estimated', () => {
    const { result } = renderHook(() =>
      useConversationCost(conversation([user(100), untracked])),
    );
    expect(result.current).toMatchObject({
      requests: 1,
      pricedRequests: 1,
      hasEstimated: true,
      measuredUsd: 0,
    });
    expect(result.current!.estimatedUsd).toBeGreaterThan(0);
    expect(result.current!.totalUsd).toBe(result.current!.estimatedUsd);
  });

  it('returns a summary with no priced requests (not null) when the model is unpriced, so the chip can say why', () => {
    const { result } = renderHook(() =>
      useConversationCost(
        conversation([user(100), untracked], {
          model: { id: 'unknown', name: 'Unknown' } as OpenAIModel,
        }),
      ),
    );
    expect(result.current).toMatchObject({
      requests: 1,
      pricedRequests: 0,
      unpricedRequests: 1,
      totalUsd: 0,
    });
  });

  it('returns null for empty and agent conversations', () => {
    expect(
      renderHook(() => useConversationCost(conversation([]))).result.current,
    ).toBeNull();
    expect(
      renderHook(() =>
        useConversationCost(
          conversation([user(10), measured('priced', OLD)], {
            model: { id: 'a', name: 'A', modelType: 'agent' } as OpenAIModel,
          }),
        ),
      ).result.current,
    ).toBeNull();
  });
});
