'use client';

import { FC } from 'react';

import { BudgetStatus } from '@/client/hooks/settings/useUsageBudgets';

import { BudgetMetric, BudgetState } from '@/lib/utils/shared/usageBudgets';

/**
 * Bar colours, stated once for every budget meter (chip, popover, settings).
 *
 * Within budget a bar wears its METRIC colour, so two stacked bars can be told
 * apart; once a stage is reached it wears the STAGE colour instead, which is
 * the more urgent thing to say. Order (emissions above cost) carries the
 * identity when both have left their resting colour.
 */
const RESTING_FILL: Record<BudgetMetric, string> = {
  emissions: 'bg-teal-700 dark:bg-teal-400',
  cost: 'bg-blue-700 dark:bg-blue-400',
};

const STAGE_FILL: Record<Exclude<BudgetState, 'ok'>, string> = {
  warn: 'bg-amber-500 dark:bg-amber-400',
  ask: 'bg-orange-600 dark:bg-orange-400',
  stop: 'bg-red-700 dark:bg-red-500',
};

/** Tailwind background classes for a meter's fill. */
export function budgetFillClass(
  metric: BudgetMetric,
  state: BudgetState,
): string {
  return state === 'ok' ? RESTING_FILL[metric] : STAGE_FILL[state];
}

/** Tailwind text classes for a figure describing a budget in `state`. */
export const BUDGET_STATE_TEXT: Record<BudgetState, string> = {
  ok: 'text-gray-700 dark:text-gray-300',
  warn: 'text-amber-700 dark:text-amber-400',
  ask: 'text-orange-700 dark:text-orange-400',
  stop: 'text-red-700 dark:text-red-400',
};

/** A meter's fill width: the share of the BUDGET used, full once it is met. */
export function budgetFillWidth(percent: number): string {
  return `${Math.min(100, Math.max(0, percent))}%`;
}

interface BudgetBarsProps {
  statuses: readonly BudgetStatus[];
}

/**
 * The thin stacked bars inside the emissions chip: one per active budget,
 * emissions above cost. Deliberately wordless — the chip's label stays what
 * it was, and the percentages live in the popover — and hidden from assistive
 * technology, which gets the same information from the chip's aria-label.
 */
export const BudgetBars: FC<BudgetBarsProps> = ({ statuses }) => {
  if (statuses.length === 0) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="budget-bars"
      className="flex w-8 flex-col gap-[3px]"
    >
      {statuses.map((status) => (
        <span
          key={status.metric}
          className="block h-1 overflow-hidden rounded-full bg-white/70 dark:bg-white/20"
        >
          <span
            data-testid={`budget-bar-${status.metric}`}
            data-state={status.state}
            className={`block h-full rounded-full ${budgetFillClass(status.metric, status.state)}`}
            style={{ width: budgetFillWidth(status.percent) }}
          />
        </span>
      ))}
    </span>
  );
};
