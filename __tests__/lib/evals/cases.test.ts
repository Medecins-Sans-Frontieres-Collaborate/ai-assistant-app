import { loadCases } from '@/evals/lib/cases';
import type { StrategyContext } from '@/evals/lib/types';
import { STRATEGIES } from '@/evals/strategies';
import { compactSystemPrompt } from '@/evals/strategies/compact';
import { describe, expect, it } from 'vitest';

describe('evals cases + strategies', () => {
  it('ships valid, uniquely-identified cases and filters by id/tag', () => {
    const all = loadCases();
    expect(all.length).toBeGreaterThan(0);
    expect(
      loadCases({ ids: ['multi-turn-followup'] }).map((c) => c.id),
    ).toEqual(['multi-turn-followup']);
    expect(
      loadCases({ tags: ['multi-turn'] }).every((c) =>
        c.tags?.includes('multi-turn'),
      ),
    ).toBe(true);
  });

  it('registers strategies under their own ids', () => {
    for (const [id, s] of Object.entries(STRATEGIES)) expect(s.id).toBe(id);
  });

  it('compact prompt includes feature lines only when the case enables them', () => {
    const base = (
      promptOptions: StrategyContext['eval']['promptOptions'],
    ): StrategyContext => ({
      modelId: 'x',
      eval: { id: 'c', turns: [{ user: 'hi' }], promptOptions },
      turnIndex: 0,
      history: [],
      userMessage: 'hi',
      invoke: async () => ({
        text: '',
        usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
      }),
    });
    expect(compactSystemPrompt(base({}))).not.toContain('Web search');
    const withSearch = compactSystemPrompt(
      base({ webSearchActive: true, userPrompt: 'Be brief.' }),
    );
    expect(withSearch).toContain('Web search');
    expect(withSearch).toContain('# User Instructions\n\nBe brief.');
  });
});
