'use client';

import { IconCoin, IconLeaf } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useBudgetFormat } from '@/client/hooks/settings/useBudgetFormat';
import {
  BudgetStatus,
  useUsageBudgetsStatus,
} from '@/client/hooks/settings/useUsageBudgets';

import {
  activityDurationParts,
  estimateActivityEquivalents,
  formatGrams,
} from '@/lib/utils/shared/emissions';
import {
  BUDGET_PERIODS,
  BUDGET_STAGES,
  BUDGET_UNITS,
  BudgetMetric,
  BudgetStage,
  BudgetUnit,
  STAGE_PERCENT_MAX,
  STAGE_PERCENT_MIN,
  UsageBudget,
  budgetLimit,
  convertBudgetAmount,
  isActivityUnit,
  setStagePercent,
} from '@/lib/utils/shared/usageBudgets';

import {
  BUDGET_STATE_TEXT,
  budgetFillClass,
} from '@/components/Emissions/BudgetBars';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * How far past the last marker the meter's scale runs, in percentage points,
 * so a marker (or the fill) never sits flush against the end of the track.
 */
const METER_HEADROOM = 10;
/** The meter always shows at least this much, so "Budget" is never the edge. */
const METER_MIN_SCALE = 112;

const INPUT_CLASS =
  'rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100';

interface DraftNumberFieldProps {
  id?: string;
  ariaLabel?: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  className: string;
  onCommit: (value: number) => void;
}

/**
 * A number field that holds what the user is typing as a string and only
 * reports a number on blur or Enter. Committing every keystroke would fight
 * the user mid-edit ("1" becoming a clamped value before "125" is finished) —
 * the same approach as EmissionsChipSetting's auto-hide field.
 */
const DraftNumberField: FC<DraftNumberFieldProps> = ({
  id,
  ariaLabel,
  value,
  min,
  max,
  step,
  className,
  onCommit,
}) => {
  const [draft, setDraft] = useState(String(value));
  // Re-sync when the stored value changes underneath us (a unit switch, a
  // threshold pushed by a neighbour). Adjusted during render so the field
  // never paints the previous value first.
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(String(value));
  }

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || draft.trim() === '') {
      setDraft(String(value));
      return;
    }
    const bounded = Math.max(
      min,
      max === undefined ? parsed : Math.min(max, parsed),
    );
    setDraft(String(bounded));
    if (bounded !== value) onCommit(bounded);
  };

  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      className={className}
    />
  );
};

/** i18n key for the word that follows the amount field. */
function amountSuffixKey(unit: BudgetUnit): string {
  return isActivityUnit(unit) ? 'hours' : unit;
}

interface BudgetMeterProps {
  status: BudgetStatus;
}

/**
 * The settings meter: usage against the budget, with a tick at the budget
 * itself and a marker under each enabled stage. The scale runs past 100% —
 * unlike the chip's bars — because the "stop" stage usually sits beyond the
 * budget and has to be somewhere on the track.
 */
const BudgetMeter: FC<BudgetMeterProps> = ({ status }) => {
  const t = useTranslations('usageBudgets');
  const { budget, percent } = status;
  const enabledStages = BUDGET_STAGES.filter(
    (stage) => budget.stages[stage].enabled,
  );
  const scaleMax = Math.max(
    METER_MIN_SCALE,
    percent + METER_HEADROOM,
    ...enabledStages.map(
      (stage) => budget.stages[stage].percent + METER_HEADROOM,
    ),
  );
  const position = (value: number): string =>
    `${(Math.min(Math.max(value, 0), scaleMax) / scaleMax) * 100}%`;

  return (
    <div className="relative mt-6 h-11" data-testid="budget-meter">
      <div className="absolute inset-x-0 top-0 h-2.5 rounded-full bg-gray-200 dark:bg-gray-700" />
      <div
        className={`absolute start-0 top-0 h-2.5 rounded-full ${budgetFillClass(status.metric, status.state)}`}
        style={{ width: position(percent) }}
      />
      <div
        className="absolute -top-5 w-0"
        style={{ insetInlineStart: position(100) }}
      >
        <span className="absolute start-0 top-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-gray-700 rtl:translate-x-1/2 dark:text-gray-300">
          {t('budgetMarker')}
        </span>
        <div className="absolute -start-px top-4 h-5 w-0.5 bg-gray-900 dark:bg-gray-100" />
      </div>
      {enabledStages.map((stage) => (
        <div
          key={stage}
          className="absolute top-3 w-0"
          style={{ insetInlineStart: position(budget.stages[stage].percent) }}
        >
          <div className="absolute -start-1 top-0 h-0 w-0 border-x-4 border-b-[6px] border-x-transparent border-b-gray-600 dark:border-b-gray-300" />
          <span className="absolute start-0 top-2 -translate-x-1/2 whitespace-nowrap text-xs text-gray-600 rtl:translate-x-1/2 dark:text-gray-400">
            {t('stageMarker', {
              stage: t(`stage.${stage}.title`),
              percent: budget.stages[stage].percent,
            })}
          </span>
        </div>
      ))}
    </div>
  );
};

interface BudgetCardProps {
  metric: BudgetMetric;
  /** Present when the budget is switched on. */
  status: BudgetStatus | undefined;
}

const BudgetCard: FC<BudgetCardProps> = ({ metric, status }) => {
  const t = useTranslations();
  const locale = useLocale();
  const budget = useSettingsStore((s) => s.usageBudgets[metric]);
  const setUsageBudget = useSettingsStore((s) => s.setUsageBudget);
  const format = useBudgetFormat();

  const update = (change: Partial<UsageBudget>) =>
    setUsageBudget(metric, change);
  const units = BUDGET_UNITS[metric];
  const Icon = metric === 'emissions' ? IconLeaf : IconCoin;
  const amountId = `usage-budget-${metric}-amount`;
  const limit = budgetLimit(budget);

  const unitLabel = (unit: BudgetUnit): string =>
    isActivityUnit(unit)
      ? t(`emissions.activities.${unit}`)
      : t(`usageBudgets.unit.${unit}`);

  // What the budget amounts to in the units the user did NOT pick: the whole
  // point of setting it by activity is seeing the others alongside.
  const equivalents =
    metric === 'emissions'
      ? estimateActivityEquivalents(limit)
          .filter((equivalent) => equivalent.key !== budget.unit)
          .map((equivalent) => {
            const parts = activityDurationParts(equivalent.seconds);
            return `${t(`emissions.duration.${parts.unit}`, { value: parts.value })} ${t(`emissions.activities.${equivalent.key}`)}`;
          })
      : [];

  const setStage = (stage: BudgetStage, enabled: boolean) =>
    update({
      stages: {
        ...budget.stages,
        [stage]: { ...budget.stages[stage], enabled },
      },
    });

  return (
    <section
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
      data-testid={`usage-budget-${metric}`}
    >
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={budget.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <Icon
          size={18}
          aria-hidden="true"
          className="text-gray-700 dark:text-gray-300"
        />
        <span className="text-sm font-semibold text-black dark:text-white">
          {t(`usageBudgets.metric.${metric}`)}
        </span>
      </label>

      {!budget.enabled ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('usageBudgets.off')}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="space-y-2.5">
            {units.length > 1 && (
              <div
                role="group"
                aria-label={t('usageBudgets.measureAs')}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="me-1 text-xs text-gray-600 dark:text-gray-400">
                  {t('usageBudgets.measureAs')}
                </span>
                {units.map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={budget.unit === unit}
                    data-unit={unit}
                    onClick={() =>
                      // Same carbon, new unit: the budget does not change
                      // size because the user changed how they picture it.
                      update({
                        unit,
                        amount: convertBudgetAmount(
                          budget.amount,
                          budget.unit,
                          unit,
                        ),
                      })
                    }
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      budget.unit === unit
                        ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900'
                        : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    {unitLabel(unit)}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-2 text-sm text-black dark:text-gray-200">
                <label htmlFor={amountId} className="font-medium">
                  {t('usageBudgets.amountLabel')}
                </label>
                <DraftNumberField
                  id={amountId}
                  value={budget.amount}
                  min={0}
                  step={metric === 'cost' ? 1 : 0.5}
                  className={`w-24 font-semibold ${INPUT_CLASS}`}
                  onCommit={(amount) => update({ amount })}
                />
                <span className="text-gray-600 dark:text-gray-400">
                  {t(
                    `usageBudgets.amountSuffix.${amountSuffixKey(budget.unit)}`,
                  )}
                </span>
              </div>
              <div
                role="group"
                aria-label={t('usageBudgets.periodLabel')}
                className="flex items-center gap-2 text-sm"
              >
                <span className="text-gray-600 dark:text-gray-400">
                  {t('usageBudgets.periodLabel')}
                </span>
                <span className="flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600">
                  {BUDGET_PERIODS.map((period) => (
                    <button
                      key={period}
                      type="button"
                      aria-pressed={budget.period === period}
                      onClick={() => update({ period })}
                      className={`px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${
                        budget.period === period
                          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                      }`}
                    >
                      {t(`usageBudgets.period.${period}`)}
                    </button>
                  ))}
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {metric === 'cost'
                ? t('usageBudgets.costNote')
                : [
                    budget.unit === 'grams'
                      ? null
                      : t('usageBudgets.equalsGrams', {
                          grams: formatGrams(limit),
                        }),
                    equivalents.length > 0
                      ? `${t('emissions.equivalents.title')} ${equivalents.join(', ')}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </p>
          </div>

          {status && (
            <div className="rounded-lg bg-gray-50 p-3 dark:bg-surface-dark">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-black dark:text-white">
                  {t('usageBudgets.usedOf', {
                    used: format(status.used, budget.unit),
                    limit: format(status.limit, budget.unit),
                    percent: Math.round(status.percent),
                  })}
                </span>
                <span
                  className={`text-xs font-semibold ${BUDGET_STATE_TEXT[status.state]}`}
                >
                  {t(`usageBudgets.status.${status.state}`)}
                </span>
              </div>
              <BudgetMeter status={status} />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('usageBudgets.resets', {
                  date: status.resetsAt.toLocaleDateString(locale, {
                    day: 'numeric',
                    month: 'long',
                  }),
                })}
              </p>
            </div>
          )}

          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {BUDGET_STAGES.map((stage) => {
              const rule = budget.stages[stage];
              const title = t(`usageBudgets.stage.${stage}.title`);
              return (
                <li
                  key={stage}
                  className="flex items-start gap-3 py-2.5"
                  data-testid={`usage-budget-${metric}-${stage}`}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
                      checked={rule.enabled}
                      onChange={(event) =>
                        setStage(stage, event.target.checked)
                      }
                    />
                    <span>
                      <span className="block text-sm text-black dark:text-gray-200">
                        {title}
                        <span className="ms-2 text-xs text-gray-500 dark:text-gray-400">
                          {t(`usageBudgets.stage.${stage}.tag`)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                        {t(`usageBudgets.stage.${stage}.description`)}
                      </span>
                    </span>
                  </label>
                  <span
                    className={`flex shrink-0 items-center gap-1 text-sm text-gray-600 dark:text-gray-400 ${
                      rule.enabled ? '' : 'opacity-50'
                    }`}
                  >
                    <DraftNumberField
                      ariaLabel={t('usageBudgets.thresholdLabel', {
                        stage: title,
                      })}
                      value={rule.percent}
                      min={STAGE_PERCENT_MIN}
                      max={STAGE_PERCENT_MAX}
                      step={5}
                      className={`w-20 ${INPUT_CLASS}`}
                      onCommit={(percent) =>
                        update({
                          stages: setStagePercent(
                            budget.stages,
                            stage,
                            percent,
                          ),
                        })
                      }
                    />
                    %
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
};

/**
 * "Your budgets" block of Settings › Usage & Impact: limits the user sets for
 * themselves on estimated emissions and estimated cost, and what happens as
 * each is approached (warn), met (ask first) or exceeded (stop).
 *
 * Store-driven and self-contained, like the other settings on this page. A
 * metric the tenant hides (cost, via `showUsageCost`) gets no card: a budget
 * on a figure the user is never shown would be unaccountable.
 */
export const UsageBudgetsSetting: FC = () => {
  const t = useTranslations('usageBudgets');
  const { showUsageCost } = useFlags();
  const { active } = useUsageBudgetsStatus();
  const metrics: BudgetMetric[] =
    showUsageCost === false ? ['emissions'] : ['emissions', 'cost'];

  return (
    <div data-testid="usage-budgets">
      <h3 className="mb-1 text-sm font-semibold text-gray-700 dark:text-gray-300">
        {t('title')}
      </h3>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('description')}
      </p>
      <div className="space-y-3">
        {metrics.map((metric) => (
          <BudgetCard
            key={metric}
            metric={metric}
            status={active.find((status) => status.metric === metric)}
          />
        ))}
      </div>
    </div>
  );
};
