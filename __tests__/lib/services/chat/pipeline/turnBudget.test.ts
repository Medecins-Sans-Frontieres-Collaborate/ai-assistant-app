import {
  STAGE_TIMEOUTS,
  resolveStageTimeouts,
} from '@/lib/services/chat/pipeline/ChatPipeline';
import {
  BASE_TURN_BUDGET,
  ROUTER_DECISION_MS,
  TURN_TIMER_CEILING_MS,
  TurnWorkload,
  WEB_SEARCH_MAX_MS,
  planTurnBudget,
} from '@/lib/services/chat/pipeline/turnBudget';

import { describe, expect, it } from 'vitest';

const plain: TurnWorkload = {
  documents: 0,
  subToolInterpreter: false,
  nativeInterpreter: false,
  webSearch: false,
  modelTimeoutMs: 90_000,
};

describe('planTurnBudget', () => {
  it('keeps exactly the compiled defaults for a plain question', () => {
    expect(planTurnBudget(plain)).toEqual({
      ...BASE_TURN_BUDGET,
      modelMs: 90_000,
    });
  });

  it('gives the five-document review headroom over its measured ~160 s', () => {
    const budget = planTurnBudget({
      ...plain,
      documents: 5,
      subToolInterpreter: true,
    });
    expect(budget.interpreterMs).toBe(270_000);
    expect(budget.toolStageMs).toBeGreaterThan(budget.interpreterMs);
    expect(budget.preModelMs).toBeGreaterThan(budget.toolStageMs);
  });

  it('never drops the interpreter below today’s 235 s for small turns', () => {
    const budget = planTurnBudget({
      ...plain,
      documents: 1,
      subToolInterpreter: true,
    });
    expect(budget.interpreterMs).toBe(BASE_TURN_BUDGET.interpreterMs);
  });

  it('budgets search and code in sequence when both may run', () => {
    const budget = planTurnBudget({
      ...plain,
      documents: 5,
      subToolInterpreter: true,
      webSearch: true,
    });
    expect(budget.toolStageMs).toBeGreaterThanOrEqual(
      ROUTER_DECISION_MS + WEB_SEARCH_MAX_MS + budget.interpreterMs,
    );
  });

  it('caps each timer at the ceiling however many files', () => {
    const budget = planTurnBudget({
      ...plain,
      documents: 40,
      subToolInterpreter: true,
    });
    expect(budget.interpreterMs).toBe(TURN_TIMER_CEILING_MS);
    expect(budget.fileStageMs).toBe(TURN_TIMER_CEILING_MS);
    expect(budget.modelMs).toBeLessThanOrEqual(TURN_TIMER_CEILING_MS);
  });

  it('does not extend the tool stage for a native interpreter turn', () => {
    const budget = planTurnBudget({
      ...plain,
      documents: 5,
      nativeInterpreter: true,
    });
    // Code runs inside the model's own streamed response there.
    expect(budget.toolStageMs).toBe(BASE_TURN_BUDGET.toolStageMs);
    expect(budget.modelMs).toBe(140_000);
  });

  it('raises the model floor for heavy turns but never lowers the user’s timeout', () => {
    expect(
      planTurnBudget({ ...plain, webSearch: true, modelTimeoutMs: 30_000 })
        .modelMs,
    ).toBe(120_000);
    expect(
      planTurnBudget({ ...plain, webSearch: true, modelTimeoutMs: 300_000 })
        .modelMs,
    ).toBe(300_000);
    expect(planTurnBudget({ ...plain, modelTimeoutMs: 30_000 }).modelMs).toBe(
      30_000,
    );
  });
});

describe('resolveStageTimeouts with a turn budget', () => {
  it('applies the scaled stages and model timeout', () => {
    const budget = planTurnBudget({
      ...plain,
      documents: 10,
      subToolInterpreter: true,
    });
    const timeouts = resolveStageTimeouts(90_000, budget);
    expect(timeouts.ToolRouterEnricher).toBe(budget.toolStageMs);
    expect(timeouts.FileProcessor).toBe(budget.fileStageMs);
    expect(timeouts.StandardChatHandler).toBe(budget.modelMs);
    expect(timeouts.RAGEnricher).toBe(STAGE_TIMEOUTS.RAGEnricher);
  });

  it('is unchanged without a budget', () => {
    expect(resolveStageTimeouts(undefined)).toBe(STAGE_TIMEOUTS);
  });
});
