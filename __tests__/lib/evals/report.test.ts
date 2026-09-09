import {
  compareCase,
  renderMarkdown,
  summarizeStrategy,
} from '@/evals/lib/report';
import type { RunResult, TurnJudgement } from '@/evals/lib/types';
import { describe, expect, it } from 'vitest';

const run = (modelId: string, strategyId: string, cost: number): RunResult => ({
  caseId: 'c1',
  modelId,
  strategyId,
  turns: [
    {
      turnIndex: 0,
      user: 'q',
      assistant: 'a',
      calls: [],
      costUsd: cost,
      latencyMs: 10,
    },
    {
      turnIndex: 1,
      user: 'q2',
      assistant: 'a2',
      calls: [],
      costUsd: 0,
      latencyMs: 10,
    },
  ],
  totalCostUsd: cost,
  totalLatencyMs: 20,
});

const judgements: TurnJudgement[] = [
  {
    turnIndex: 0,
    parity: 8,
    dimensions: { accuracy: 8, completeness: 8, formatting: 9, concision: 7 },
    preference: 'candidate',
    rationale: 'fine',
  },
  {
    turnIndex: 1,
    parity: 4,
    dimensions: { accuracy: 4, completeness: 3, formatting: 6, concision: 5 },
    preference: 'tie',
    rationale: 'lost context',
  },
];

describe('evals report', () => {
  it('aggregates parity, win rate and cost ratio per case and flags over-budget', () => {
    const cmp = compareCase(
      run('big', 'baseline', 1),
      run('small', 'compact', 0.6),
      { judgements, judgeCostUsd: 0.01 },
      0.5,
    );
    expect(cmp.meanParity).toBe(6);
    expect(cmp.candidateWinRate).toBe(0.75);
    expect(cmp.costRatio).toBeCloseTo(0.6);
    expect(cmp.overBudget).toBe(true);

    const summary = summarizeStrategy('compact', 'small', [cmp]);
    expect(summary.overBudgetCases).toBe(1);
    expect(summary.meanCostRatio).toBeCloseTo(0.6);
    expect(summary.totalJudgeCostUsd).toBe(0.01);
  });

  it('renders a markdown report with the weakest turn called out', () => {
    const cmp = compareCase(
      run('big', 'baseline', 1),
      run('small', 'compact', 0.2),
      { judgements, judgeCostUsd: 0 },
      0.5,
    );
    const md = renderMarkdown({
      generatedAt: '2026-08-21T00:00:00.000Z',
      goalModelId: 'big',
      aspirationalModelId: 'small',
      goalStrategyId: 'baseline',
      judgeModelId: 'big',
      costCeiling: 0.5,
      strategies: [summarizeStrategy('compact', 'small', [cmp])],
    });
    expect(md).toContain('| `compact` | 6.00 | 75% | 0.20× | 0/1 |');
    expect(md).toContain('weakest turn 2: parity 4');
    expect(md).not.toContain('over budget');
  });
});
