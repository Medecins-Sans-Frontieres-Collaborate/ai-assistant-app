import { calculateCostUsd, costRatio } from '@/evals/lib/cost';
import type { EvalModelMeta } from '@/evals/lib/models';
import { describe, expect, it } from 'vitest';

const meta: EvalModelMeta = {
  id: 'x',
  sdk: 'azure-openai',
  pricing: { inputPer1M: 2, outputPer1M: 10, cachedInputPer1M: 0.2 },
};

describe('evals cost', () => {
  it('bills cached prompt tokens at the cached rate', () => {
    const cost = calculateCostUsd(
      {
        promptTokens: 1_000_000,
        cachedPromptTokens: 500_000,
        completionTokens: 100_000,
      },
      meta,
    );
    // 500k uncached * 2 + 500k cached * 0.2 + 100k * 10 = 1 + 0.1 + 1
    expect(cost).toBeCloseTo(2.1, 6);
  });

  it('falls back to the input rate when no cached price is known', () => {
    const cost = calculateCostUsd(
      {
        promptTokens: 1_000_000,
        cachedPromptTokens: 1_000_000,
        completionTokens: 0,
      },
      { ...meta, pricing: { inputPer1M: 2, outputPer1M: 10 } },
    );
    expect(cost).toBeCloseTo(2, 6);
  });

  it('returns 0 without pricing and infinity when the goal is free but the candidate is not', () => {
    expect(
      calculateCostUsd(
        { promptTokens: 5, cachedPromptTokens: 0, completionTokens: 5 },
        { id: 'y', sdk: 'openai' },
      ),
    ).toBe(0);
    expect(costRatio(0.1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(costRatio(0, 0)).toBe(0);
    expect(costRatio(0.25, 1)).toBe(0.25);
  });
});
