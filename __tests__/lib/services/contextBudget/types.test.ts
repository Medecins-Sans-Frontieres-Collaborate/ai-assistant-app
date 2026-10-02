import {
  CONTEXT_BUDGET_DEFAULTS,
  ContextBudgetConfig,
  ContextBudgetConfigSchema,
  ContextBudgetSettingsWriteSchema,
  resolveContextBudgetConfig,
  resolveHistoryBudget,
} from '@/lib/services/contextBudget/types';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const budgetFor = (id: OpenAIModelID, config = CONTEXT_BUDGET_DEFAULTS) =>
  resolveHistoryBudget(OpenAIModels[id], config);

describe('resolveHistoryBudget (code defaults)', () => {
  it('gives the 128k GPT models 48k of history instead of their 16k output limit', () => {
    for (const id of [
      OpenAIModelID.GPT_5_2,
      OpenAIModelID.GPT_5_2_CHAT,
      OpenAIModelID.GPT_5_4,
      OpenAIModelID.GPT_5_6_SOL,
    ]) {
      expect(budgetFor(id)).toEqual({
        tokens: 48_000,
        windowTokens: 112_000,
        minRecentMessages: 3,
      });
    }
  });

  it('keeps Claude at the 128k it has always had (family override)', () => {
    expect(budgetFor(OpenAIModelID.CLAUDE_SONNET_5).tokens).toBe(128_000);
    expect(budgetFor(OpenAIModelID.CLAUDE_OPUS_5).tokens).toBe(128_000);
  });

  it('never exceeds the fraction of the model window', () => {
    // 200k window, 64k output → 136k room × 0.75 = 102k < the 128k override.
    expect(budgetFor(OpenAIModelID.CLAUDE_SONNET_4_5).tokens).toBe(102_000);
    // Unknown discovered model: 32k window, 4k output → 21k.
    expect(
      resolveHistoryBudget(
        { id: 'brand-new', maxLength: 32_000, tokenLimit: 4_096 },
        CONTEXT_BUDGET_DEFAULTS,
      ).tokens,
    ).toBe(20_928);
  });

  it('falls back to the old rule when the window is unknown', () => {
    expect(
      resolveHistoryBudget(
        { id: 'odd', maxLength: 0, tokenLimit: 16_000 },
        CONTEXT_BUDGET_DEFAULTS,
      ),
    ).toEqual({ tokens: 16_000, windowTokens: 16_000, minRecentMessages: 3 });
  });

  it('lets a model override beat a family override beat the standard budget', () => {
    const config = {
      ...CONTEXT_BUDGET_DEFAULTS,
      familyOverrides: { gpt: 24_000 },
      modelOverrides: { 'gpt-5.4': 80_000 },
    };
    expect(budgetFor(OpenAIModelID.GPT_5_2, config).tokens).toBe(24_000);
    expect(budgetFor(OpenAIModelID.GPT_5_4, config).tokens).toBe(80_000);
    expect(budgetFor(OpenAIModelID.MISTRAL_LARGE_3, config).tokens).toBe(
      48_000,
    );
  });
});

describe('config resolution', () => {
  const doc = (budget: unknown): ContextBudgetConfig =>
    ContextBudgetConfigSchema.parse({
      version: 1,
      budget,
      updatedBy: 'admin@example.org',
      updatedAt: '2026-10-02T00:00:00.000Z',
    });

  it('answers from the code defaults with no document', () => {
    expect(resolveContextBudgetConfig(null)).toEqual(CONTEXT_BUDGET_DEFAULTS);
  });

  it('lets a stored override map REPLACE the default one', () => {
    expect(
      resolveContextBudgetConfig(doc({ familyOverrides: {} })).familyOverrides,
    ).toEqual({});
  });

  it('reads leniently: a bad field falls back alone, a bad override entry is dropped', () => {
    const resolved = resolveContextBudgetConfig(
      doc({
        historyTokens: 999_999_999,
        minRecentMessages: 5,
        modelOverrides: { 'gpt-5.4': 60_000, broken: 'lots' },
      }),
    );
    expect(resolved.historyTokens).toBe(CONTEXT_BUDGET_DEFAULTS.historyTokens);
    expect(resolved.minRecentMessages).toBe(5);
    expect(resolved.modelOverrides).toEqual({ 'gpt-5.4': 60_000 });
  });

  it('writes strictly: out-of-range or unknown fields are rejected', () => {
    expect(
      ContextBudgetSettingsWriteSchema.safeParse({ historyTokens: 1_000 })
        .success,
    ).toBe(false);
    expect(
      ContextBudgetSettingsWriteSchema.safeParse({ somethingElse: 1 }).success,
    ).toBe(false);
    expect(
      ContextBudgetSettingsWriteSchema.safeParse({
        historyTokens: 64_000,
        familyOverrides: { claude: 200_000 },
      }).success,
    ).toBe(true);
  });
});
