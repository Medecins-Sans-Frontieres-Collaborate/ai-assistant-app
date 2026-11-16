'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useUsageBudgetsStatus } from '@/client/hooks/settings/useUsageBudgets';
import {
  RunEstimateInput,
  formatEstimate,
  useRunEstimate,
} from '@/client/hooks/workflows/useRunEstimate';

import { ASSUMPTIONS_VERSION } from '@/lib/utils/shared/emissions';
import { evaluateBudget } from '@/lib/utils/shared/usageBudgets';

import { BUDGET_STATE_TEXT } from '@/components/Emissions/BudgetBars';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface RunEstimateHintProps extends RunEstimateInput {
  /**
   * The run may finish in fewer passes than `passes` (agentic translation
   * stops as soon as a review approves), so the figure is an upper bound and
   * the copy must say so rather than promising a number the run will usually
   * beat.
   */
  atMost?: boolean;
}

/**
 * "~4 passes · ~15 g CO₂e" beside a run control
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §5d).
 *
 * Shown BEFORE the run, because that is when the choice between quick and
 * agentic — an order-of-magnitude difference — is still open. Follows the
 * same visibility setting as the badge and the chat chip: a user who hid the
 * impact chrome should not meet it again next to every button.
 */
export const RunEstimateHint: FC<RunEstimateHintProps> = ({
  atMost,
  ...input
}) => {
  const t = useTranslations();
  const { showUsageImpact } = useFlags();
  const visibility = useSettingsStore((s) => s.emissionsChipVisibility);
  const estimate = useRunEstimate(input);
  const { active } = useUsageBudgetsStatus();

  // Same fail-open gate as the chip: only an explicit `false` hides it.
  if (showUsageImpact === false) return null;
  if (visibility === 'hidden') return null;
  if (!estimate) return null;

  // Where this run would leave the emissions budget, when there is one. The
  // figure the user can still act on is the one AFTER the run, so it is
  // coloured by the stage the run would reach, not the one they are in.
  const budget = active.find((status) => status.metric === 'emissions');
  const projected =
    budget && budget.limit > 0
      ? evaluateBudget(budget.budget, budget.used + estimate.gCO2e)
      : null;

  return (
    <span
      className="text-[11px] text-gray-500 dark:text-gray-400"
      title={t('emissions.workflow.estimateTooltip', {
        version: ASSUMPTIONS_VERSION,
      })}
    >
      {t(
        atMost
          ? 'emissions.workflow.estimateAtMost'
          : 'emissions.workflow.estimate',
        {
          passes: String(estimate.passes),
          grams: formatEstimate(estimate.gCO2e),
        },
      )}
      {budget && projected && (
        <span
          className={`ms-1.5 ${projected.state === 'ok' ? '' : `font-medium ${BUDGET_STATE_TEXT[projected.state]}`}`}
          data-testid="run-budget-projection"
        >
          {'· '}
          {t('usageBudgets.runProjection', {
            from: Math.round(budget.percent),
            to: Math.round(projected.percent),
          })}
        </span>
      )}
    </span>
  );
};
