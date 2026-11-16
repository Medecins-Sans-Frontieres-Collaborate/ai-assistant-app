'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useBudgetFormat } from '@/client/hooks/settings/useBudgetFormat';
import { useUsageBudgetsStatus } from '@/client/hooks/settings/useUsageBudgets';

import { BUDGET_BASE_UNIT } from '@/lib/utils/shared/usageBudgets';

import {
  BUDGET_STATE_TEXT,
  budgetFillClass,
  budgetFillWidth,
} from '@/components/Emissions/BudgetBars';
import { SettingsSection } from '@/components/Settings/types';

import { useUIStore } from '@/client/stores/uiStore';

/**
 * "Your budgets" block of the emissions popover: the words behind the chip's
 * wordless bars. One row per active budget — how much is used, in the unit
 * the budget is MEASURED in (CO₂e or dollars), not the activity it may have
 * been set by: the rows above already give this conversation's equivalents,
 * and an equivalent of a period total is an estimate of an estimate — and a
 * link to change it.
 *
 * Renders nothing when the user has no budget switched on, so the popover is
 * unchanged for everyone who has not asked for this.
 */
export const BudgetSummary: FC = () => {
  const t = useTranslations();
  const { active } = useUsageBudgetsStatus();
  const format = useBudgetFormat();
  const openSettingsAt = useUIStore((s) => s.openSettingsAt);

  if (active.length === 0) return null;

  return (
    <div
      className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700"
      data-testid="budget-summary"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-gray-700 dark:text-gray-300">
          {t('usageBudgets.summaryTitle')}
        </p>
        <button
          type="button"
          onClick={() => openSettingsAt(SettingsSection.USAGE_IMPACT)}
          className="rounded text-blue-700 hover:underline focus:outline-none focus:ring-1 focus:ring-blue-500 dark:text-blue-400"
        >
          {t('usageBudgets.actions.edit')}
        </button>
      </div>
      {active.map((status) => (
        <div key={status.metric} className="mt-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-gray-600 dark:text-gray-400">
              {t(`usageBudgets.metricShort.${status.metric}`)}
            </span>
            <span
              className={`shrink-0 font-semibold tabular-nums ${BUDGET_STATE_TEXT[status.state]}`}
            >
              {t('usageBudgets.percent', {
                percent: Math.round(status.percent),
              })}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className={`h-full rounded-full ${budgetFillClass(status.metric, status.state)}`}
              style={{ width: budgetFillWidth(status.percent) }}
            />
          </div>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            {t('usageBudgets.usedOfShort', {
              used: format(status.used, BUDGET_BASE_UNIT[status.metric]),
              limit: format(status.limit, BUDGET_BASE_UNIT[status.metric]),
            })}
          </p>
        </div>
      ))}
    </div>
  );
};
