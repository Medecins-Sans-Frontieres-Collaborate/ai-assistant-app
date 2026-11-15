'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  BUDGET_METRICS,
  BudgetEvaluation,
  BudgetMetric,
  BudgetState,
  UsageBudget,
  evaluateBudget,
  hasReached,
  localDayKey,
  nextPeriodStart,
  periodBuckets,
  periodStart,
  worseState,
} from '@/lib/utils/shared/usageBudgets';
import { sumUsageImpact } from '@/lib/utils/shared/usageImpact';

import {
  BudgetGatedActionKind,
  useBudgetGateStore,
} from '@/client/stores/budgetGateStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/** How often the "today" key is re-read, so a tab left open rolls over. */
const DAY_ROLLOVER_POLL_MS = 60_000;

/**
 * The current local day key, kept fresh across midnight. Budget periods are
 * derived from it, so without this a tab open overnight would keep showing
 * yesterday's (or last month's) total until something else re-rendered it.
 */
export function useTodayKey(): string {
  const [todayKey, setTodayKey] = useState(() => localDayKey(new Date()));
  useEffect(() => {
    const timer = setInterval(
      () => setTodayKey(localDayKey(new Date())),
      DAY_ROLLOVER_POLL_MS,
    );
    return () => clearInterval(timer);
  }, []);
  return todayKey;
}

export interface BudgetStatus extends BudgetEvaluation {
  metric: BudgetMetric;
  budget: UsageBudget;
  /** Local day key of the period's first day; identifies the period. */
  periodKey: string;
  /** When usage resets (local midnight starting the next period). */
  resetsAt: Date;
}

export interface UsageBudgetsStatus {
  /** One entry per budget that is switched on and allowed by its flag. */
  active: BudgetStatus[];
  /** The most severe state across `active`. */
  state: BudgetState;
  /** The budget that produced `state` (emissions wins a tie), if any. */
  leading: BudgetStatus | null;
  todayKey: string;
}

/**
 * Evaluates the user's personal budgets against this period's usage.
 *
 * A budget is inactive — reported nowhere, enforced nowhere — when it is
 * switched off or when the tenant hides its figures: emissions follow the
 * `showUsageImpact` flag and cost follows `showUsageCost`, with the same
 * fail-open rule as the chip (only an explicit `false` hides).
 */
export function useUsageBudgetsStatus(): UsageBudgetsStatus {
  const { showUsageImpact, showUsageCost } = useFlags();
  const budgets = useSettingsStore((s) => s.usageBudgets);
  const ledger = useSettingsStore((s) => s.dailyTokenUsage);
  const models = useSettingsStore((s) => s.models);
  const todayKey = useTodayKey();

  return useMemo(() => {
    // Parsed back from the key rather than read from the clock so the memo
    // stays a pure function of its inputs.
    const [year, month, day] = todayKey.split('-').map(Number);
    const now = new Date(year, month - 1, day);
    const allowed: Record<BudgetMetric, boolean> = {
      emissions: showUsageImpact !== false,
      cost: showUsageImpact !== false && showUsageCost !== false,
    };

    const active: BudgetStatus[] = [];
    for (const metric of BUDGET_METRICS) {
      const budget = budgets[metric];
      if (!budget.enabled || !allowed[metric]) continue;
      const totals = sumUsageImpact(
        periodBuckets(ledger, budget.period, now),
        models,
      );
      const used = metric === 'emissions' ? totals.gCO2e : totals.usd;
      active.push({
        metric,
        budget,
        ...evaluateBudget(budget, used),
        periodKey: localDayKey(periodStart(budget.period, now)),
        resetsAt: nextPeriodStart(budget.period, now),
      });
    }

    let state: BudgetState = 'ok';
    let leading: BudgetStatus | null = null;
    for (const status of active) {
      const next = worseState(state, status.state);
      // Strictly worse only, so the first metric keeps a tie.
      if (next !== state) {
        state = next;
        leading = status;
      }
    }
    return { active, state, leading, todayKey };
  }, [budgets, ledger, models, todayKey, showUsageImpact, showUsageCost]);
}

export interface BudgetGate {
  status: UsageBudgetsStatus;
  /** A "stop" stage is reached: nothing may be sent this period. */
  isStopped: boolean;
  /** An action is being held for confirmation. */
  isHolding: boolean;
  /**
   * Runs `action` unless a budget intervenes.
   *
   * - stop → the action is dropped (the notice explains why).
   * - ask  → the action is held until the user confirms, unless they chose
   *          "Don't ask again today".
   * - otherwise it runs immediately.
   *
   * @returns true when the action ran now, false when it was held or dropped.
   */
  guard: (action: () => void, kind?: BudgetGatedActionKind) => boolean;
}

/**
 * The single decision point for "may this be sent?" under personal budgets.
 * Every entry point that spends tokens on the user's behalf — the composer,
 * regenerate, a workflow's run button — goes through {@link BudgetGate.guard}.
 */
export function useBudgetGate(): BudgetGate {
  const status = useUsageBudgetsStatus();
  const snoozedDay = useSettingsStore((s) => s.usageBudgetAskSnoozedDay);
  const isHolding = useBudgetGateStore((s) => s.pending !== null);
  const hold = useBudgetGateStore((s) => s.hold);

  const isStopped = hasReached(status.state, 'stop');
  const mustAsk =
    !isStopped &&
    hasReached(status.state, 'ask') &&
    snoozedDay !== status.todayKey;

  const guard = useCallback(
    (action: () => void, kind: BudgetGatedActionKind = 'message') => {
      if (isStopped) return false;
      if (mustAsk) {
        hold({ kind, run: action });
        return false;
      }
      action();
      return true;
    },
    [isStopped, mustAsk, hold],
  );

  return { status, isStopped, isHolding, guard };
}
