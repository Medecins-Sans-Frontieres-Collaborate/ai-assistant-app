'use client';

import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import React, { FC, useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import type { LimitEntry } from '@/lib/services/limits/types';

import {
  buildQualifierCatalog,
  qualifierLabel,
} from '@/lib/utils/app/limitsModelCatalog';
import {
  COST_ASSUMPTIONS,
  COST_PERIODS,
  DEPLOYMENTS,
  EstimateResult,
  PROFILE_KEYS,
  formatUsdParts,
  perThousandRequestsUsd,
  resolveProfile,
} from '@/lib/utils/shared/costEstimator';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_HEADING,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { useLimitsCost } from '@/components/Limits/LimitsCostContext';
import {
  CalculatorIssue,
  CalculatorState,
  CrossCheckCell,
  addMixRow,
  crossCheckCells,
  deploymentApplicable,
  initialCalculatorState,
  mixPresetDefault,
  mixPresetFamily,
  runCalculator,
} from '@/components/Limits/costCalculatorState';
import {
  LIMITS_CHIP_WARN,
  LIMITS_NOTE_CARD,
} from '@/components/Limits/limitsClasses';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { getDefaultModel } from '@/config/models';

interface CostCalculatorProps {
  /**
   * The caps the cross-check runs against: the global defaults DRAFT, or
   * (scoped mode) the union of the scoped admin's own override entries.
   */
  caps: LimitEntry[];
  mode: 'global' | 'scoped';
}

const TH =
  'px-2 py-1 text-left text-xs font-medium text-gray-500 dark:text-gray-400';
const TD = 'px-2 py-1 text-sm text-black dark:text-white';
const TD_NUM =
  'px-2 py-1 text-right text-sm tabular-nums text-black dark:text-white';

/**
 * The estimator (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4c): users × requests
 * per period × a model mix at a request profile → spend per period and
 * annualized, cross-checked against the caps in the DRAFT (resolved
 * client-side with the pure resolver and a synthetic principal, so unsaved
 * edits count and the copy says so).
 *
 * Every number is an upper-bound estimate at list price; the disclosure
 * line under the results carries the assumptions. Inputs live in component
 * state only — nothing is persisted. Excluded (unpriced) models stay in the
 * mix as $0 rows and mark the result incomplete; they are never renormalized
 * away. Rendered only behind `useLimitsCost().calculator`, lazily.
 */
export const CostCalculator: FC<CostCalculatorProps> = ({ caps, mode }) => {
  const t = useTranslations('limits');
  const locale = useLocale();
  const { pricing } = useLimitsCost();
  const models = useSettingsStore((s) => s.models);

  const [state, setState] = useState<CalculatorState>(() =>
    initialCalculatorState(
      getDefaultModel(models.length > 0 ? models : undefined),
    ),
  );
  const [pendingPick, setPendingPick] = useState('');

  const patch = (next: Partial<CalculatorState>) =>
    setState((current) => ({ ...current, ...next }));

  const catalog = useMemo(() => buildQualifierCatalog(models), [models]);
  /** Picker choices; byom/local models are hidden unless opted in. */
  const pickerModels = useMemo(
    () =>
      state.includeByom
        ? catalog.models
        : catalog.models.filter(
            (m) =>
              !/^(byom|local)-/i.test(m.modelId) &&
              models.find((x) => x.id === m.modelId)?.isCustomSourceModel !==
                true &&
              models.find((x) => x.id === m.modelId)?.isLocalModel !== true,
          ),
    [catalog.models, models, state.includeByom],
  );

  const multiplierApplicable = useMemo(
    () => deploymentApplicable(state.mix, pricing),
    [state.mix, pricing],
  );

  const run = useMemo(() => {
    try {
      return runCalculator(state, models, caps, pricing);
    } catch {
      return { issues: [{ field: 'mix' }] as CalculatorIssue[] };
    }
  }, [state, models, caps, pricing]);

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const integerFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );
  const zeroUsd = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
      }).format(0),
    [locale],
  );
  /** Money for display — the only rounding point (formatUsdParts). */
  const usd = (value: number): string => {
    const parts = formatUsdParts(value, locale);
    if (parts.kind === 'zero') return zeroUsd;
    if (parts.kind === 'lessThan') {
      return t('cost.calculator.lessThan', { amount: parts.text });
    }
    return parts.text;
  };

  const pick = (raw: string) => {
    if (!raw) return;
    const [kind, value] = raw.split(':');
    if (kind === 'family') {
      const family = catalog.families.find((f) => f.series === value);
      if (family) patch({ mix: mixPresetFamily(family.modelIds) });
    } else {
      patch({ mix: addMixRow(state.mix, value) });
    }
    setPendingPick('');
  };

  const profileHint = (() => {
    const key = state.profile === 'custom' ? null : state.profile;
    if (!key) return null;
    const resolved = resolveProfile(key);
    return t('cost.calculator.profileHint', {
      promptTokens: integerFormat.format(resolved.promptTokens),
      completionTokens: integerFormat.format(resolved.completionTokens),
    });
  })();

  const periodLabel = t(
    `cost.calculator.periodOptions.${state.period}` as never,
  );

  return (
    <section
      className={`space-y-4 ${ADMIN_CARD}`}
      aria-labelledby="limits-cost-calculator-title"
    >
      <div>
        <h2 id="limits-cost-calculator-title" className={ADMIN_HEADING}>
          {t('cost.calculator.title')}
        </h2>
        <p className={ADMIN_MUTED}>{t('cost.calculator.description')}</p>
        <p className={ADMIN_MUTED}>
          {mode === 'scoped'
            ? t('cost.calculator.scopedNote')
            : t('cost.calculator.draftNote')}
        </p>
      </div>

      {/* ── Inputs ─────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field id="limits-cost-users" label={t('cost.calculator.users')}>
          <input
            id="limits-cost-users"
            type="number"
            min={0}
            step={1}
            className={`w-full ${ADMIN_FIELD}`}
            value={state.users}
            onChange={(e) => patch({ users: e.target.value })}
          />
        </Field>
        <Field id="limits-cost-requests" label={t('cost.calculator.requests')}>
          <input
            id="limits-cost-requests"
            type="number"
            min={0}
            className={`w-full ${ADMIN_FIELD}`}
            value={state.requests}
            onChange={(e) => patch({ requests: e.target.value })}
          />
        </Field>
        <Field id="limits-cost-period" label={t('cost.calculator.period')}>
          <select
            id="limits-cost-period"
            className={`w-full ${ADMIN_FIELD}`}
            value={state.period}
            onChange={(e) =>
              patch({ period: e.target.value as CalculatorState['period'] })
            }
          >
            {COST_PERIODS.map((period) => (
              <option key={period} value={period}>
                {t(`cost.calculator.periodOptions.${period}` as never)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="limits-cost-profile"
          label={t('cost.calculator.profile')}
          hint={profileHint ?? undefined}
        >
          <select
            id="limits-cost-profile"
            className={`w-full ${ADMIN_FIELD}`}
            value={state.profile}
            onChange={(e) =>
              patch({
                profile: e.target.value as CalculatorState['profile'],
              })
            }
          >
            {[...PROFILE_KEYS, 'custom' as const].map((key) => (
              <option key={key} value={key}>
                {t(`cost.calculator.profileOptions.${key}` as never)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="limits-cost-deployment"
          label={t('cost.calculator.deployment')}
          hint={
            multiplierApplicable ? undefined : t('cost.calculator.deploymentNa')
          }
        >
          <select
            id="limits-cost-deployment"
            className={`w-full ${ADMIN_FIELD}`}
            value={state.deployment}
            disabled={!multiplierApplicable}
            aria-describedby={
              multiplierApplicable ? undefined : 'limits-cost-deployment-hint'
            }
            onChange={(e) =>
              patch({
                deployment: e.target.value as CalculatorState['deployment'],
              })
            }
          >
            {DEPLOYMENTS.map((deployment) => (
              <option key={deployment} value={deployment}>
                {t(`cost.calculator.deploymentOptions.${deployment}` as never)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="limits-cost-tool-rounds"
          label={t('cost.calculator.toolRounds')}
          hint={t('cost.calculator.toolRoundsHint', {
            key: t('label.mcpRoundsPerRequest'),
          })}
        >
          <input
            id="limits-cost-tool-rounds"
            type="number"
            min={1}
            step={1}
            className={`w-full ${ADMIN_FIELD}`}
            value={state.toolRounds}
            onChange={(e) => patch({ toolRounds: e.target.value })}
          />
        </Field>
      </div>

      {state.profile === 'custom' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            id="limits-cost-prompt-tokens"
            label={t('cost.calculator.promptTokens')}
          >
            <input
              id="limits-cost-prompt-tokens"
              type="number"
              min={0}
              className={`w-full ${ADMIN_FIELD}`}
              value={state.promptTokens}
              onChange={(e) => patch({ promptTokens: e.target.value })}
            />
          </Field>
          <Field
            id="limits-cost-completion-tokens"
            label={t('cost.calculator.completionTokens')}
          >
            <input
              id="limits-cost-completion-tokens"
              type="number"
              min={0}
              className={`w-full ${ADMIN_FIELD}`}
              value={state.completionTokens}
              onChange={(e) => patch({ completionTokens: e.target.value })}
            />
          </Field>
          <Field
            id="limits-cost-cached-share"
            label={t('cost.calculator.cachedShare')}
            hint={t('cost.calculator.cachedShareHint')}
          >
            <input
              id="limits-cost-cached-share"
              type="number"
              min={0}
              max={100}
              className={`w-full ${ADMIN_FIELD}`}
              value={state.cachedSharePercent}
              onChange={(e) => patch({ cachedSharePercent: e.target.value })}
            />
          </Field>
        </div>
      )}

      <label className="flex items-start gap-1.5 text-sm text-black dark:text-white">
        <input
          type="checkbox"
          className={`mt-0.5 ${ADMIN_CHECKBOX}`}
          checked={state.includeByom}
          onChange={(e) => patch({ includeByom: e.target.checked })}
        />
        <span>
          {t('cost.calculator.includeByom')}
          <span className={`block ${ADMIN_HINT}`}>
            {t('cost.calculator.includeByomHint')}
          </span>
        </span>
      </label>

      {/* ── Mix ─────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className={ADMIN_HEADING}>{t('cost.calculator.mix')}</h3>
        {state.mix.length === 0 && (
          <p className={ADMIN_MUTED}>{t('cost.calculator.mixEmpty')}</p>
        )}
        {state.mix.map((row) => {
          const label = qualifierLabel(catalog, { modelId: row.modelId });
          return (
            <div
              key={row.modelId}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="min-w-[180px] flex-1 text-sm text-black dark:text-white">
                {label}
              </span>
              <div className="flex items-center gap-1.5">
                <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
                  {t('cost.calculator.share')}
                  <input
                    type="number"
                    min={0}
                    className={`w-24 ${ADMIN_FIELD}`}
                    value={row.share}
                    aria-label={t('cost.calculator.shareOf', { model: label })}
                    onChange={(e) =>
                      patch({
                        mix: state.mix.map((r) =>
                          r.modelId === row.modelId
                            ? { ...r, share: e.target.value }
                            : r,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className={ADMIN_BTN_ICON_DANGER}
                  aria-label={t('cost.calculator.removeModel', {
                    model: label,
                  })}
                  onClick={() =>
                    patch({
                      mix: state.mix.filter((r) => r.modelId !== row.modelId),
                    })
                  }
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <IconPlus size={14} className="text-gray-500 dark:text-gray-400" />
          <select
            className={ADMIN_FIELD}
            value={pendingPick}
            onChange={(e) => pick(e.target.value)}
            aria-label={t('cost.calculator.addModel')}
          >
            <option value="">{t('cost.calculator.addModel')}</option>
            {catalog.families.length > 0 && (
              <optgroup label={t('families')}>
                {catalog.families.map((family) => (
                  <option key={family.series} value={`family:${family.series}`}>
                    {family.label}
                  </option>
                ))}
              </optgroup>
            )}
            {pickerModels.length > 0 && (
              <optgroup label={t('modelsGroup')}>
                {pickerModels.map((model) => (
                  <option key={model.modelId} value={`model:${model.modelId}`}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() =>
              patch({
                mix: mixPresetDefault(
                  getDefaultModel(models.length > 0 ? models : undefined),
                ),
              })
            }
          >
            {t('cost.calculator.presetDefault')}
          </button>
        </div>
        <p className={ADMIN_MUTED}>{t('cost.calculator.presetFamilyHint')}</p>
      </div>

      {/* ── Results ─────────────────────────────────────────────────────── */}
      {'issues' in run ? (
        <ul role="alert" className="space-y-1">
          {run.issues.map((issue, i) => (
            <li
              key={`${issue.field}-${issue.modelId ?? i}`}
              className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300"
            >
              <IconAlertTriangle size={14} aria-hidden="true" />
              {issue.field === 'share'
                ? t('cost.calculator.issues.share', {
                    model: issue.modelId
                      ? qualifierLabel(catalog, { modelId: issue.modelId })
                      : '',
                  })
                : t(`cost.calculator.issues.${issue.field}` as never)}
            </li>
          ))}
        </ul>
      ) : (
        <Results
          run={run}
          catalog={catalog}
          usd={usd}
          numberFormat={numberFormat}
          periodLabel={periodLabel}
          mode={mode}
          t={t}
        />
      )}
    </section>
  );
};

/** Label + control + optional hint; the label is paired by id, not by wrapping. */
const Field: FC<{
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ id, label, hint, children }) => (
  <div>
    <label htmlFor={id} className={ADMIN_LABEL}>
      {label}
    </label>
    {children}
    {hint && (
      <p id={`${id}-hint`} className={ADMIN_HINT}>
        {hint}
      </p>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

type Translate = ReturnType<typeof useTranslations<'limits'>>;

interface ResultsProps {
  run: Exclude<ReturnType<typeof runCalculator>, { issues: CalculatorIssue[] }>;
  catalog: ReturnType<typeof buildQualifierCatalog>;
  usd: (value: number) => string;
  numberFormat: Intl.NumberFormat;
  periodLabel: string;
  mode: 'global' | 'scoped';
  t: Translate;
}

const Results: FC<ResultsProps> = ({
  run,
  catalog,
  usd,
  numberFormat,
  periodLabel,
  mode,
  t,
}) => {
  const { parsed, result, cellsByModelId, impliedRequestsPerUserPerDay } = run;
  const { entered, ceiling, capBinding, bindingCells } = result;
  const { users } = parsed.input;
  const annualFactor = COST_ASSUMPTIONS.periodDays.year / entered.periodDays;
  const cells = crossCheckCells(cellsByModelId);
  const anyMonthCell = cells.some(
    (c) => c.window === 'month' && typeof c.value === 'number',
  );
  const label = (modelId: string) => qualifierLabel(catalog, { modelId });
  const perRequestText = (perRequest: number) =>
    perRequest > 0 && perRequest < 0.01
      ? `${usd(perRequest)} (${t('cost.calculator.perThousand', {
          amount: usd(perThousandRequestsUsd(perRequest)),
        })})`
      : usd(perRequest);

  return (
    <div className="space-y-4">
      {parsed.droppedRows.length > 0 && (
        <p className={ADMIN_MUTED}>
          {t('cost.calculator.droppedRows', {
            count: parsed.droppedRows.length,
            models: parsed.droppedRows.map(label).join(', '),
          })}
        </p>
      )}

      {/* Per-model table */}
      <div className="overflow-x-auto">
        <table className="w-full" data-testid="cost-per-model">
          <thead>
            <tr>
              <th className={TH}>{t('cost.calculator.columns.model')}</th>
              <th className={`${TH} text-right`}>
                {t('cost.calculator.columns.perRequest')}
              </th>
              <th className={`${TH} text-right`}>
                {t('cost.calculator.columns.requestsPerPeriod', {
                  period: periodLabel,
                })}
              </th>
              <th className={`${TH} text-right`}>
                {t('cost.calculator.columns.spendPerPeriod', {
                  period: periodLabel,
                })}
              </th>
              <th className={`${TH} text-right`}>
                {t('cost.calculator.columns.spendPerYear')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entered.perModel.map((row) => {
              const requests =
                row.share * entered.requestsPerUserPerPeriod * users;
              const spend = requests * row.perRequest.total;
              return (
                <tr
                  key={row.modelId}
                  className="border-t border-gray-200 dark:border-gray-700"
                >
                  <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {label(row.modelId)}
                      {row.perRequest.flags.lowConfidence && (
                        <span className={ADMIN_CHIP_NEUTRAL}>
                          {t('cost.calculator.chips.lowConfidence')}
                        </span>
                      )}
                      {row.perRequest.flags.alias && (
                        <span className={ADMIN_CHIP_NEUTRAL}>
                          {t('cost.calculator.chips.alias')}
                        </span>
                      )}
                      {!row.servedInRing && (
                        <span className={ADMIN_CHIP_NEUTRAL}>
                          {t('cost.calculator.chips.notServed')}
                        </span>
                      )}
                      {/* `parsed.input.deployment` is the EFFECTIVE deployment
                          (runCalculator → effectiveDeployment): Global while
                          the selector is greyed, so an all-Marketplace mix
                          never grows a row of these chips. */}
                      {row.perRequest.flags.multiplierNotApplicable &&
                        parsed.input.deployment !== 'global' && (
                          <span className={ADMIN_CHIP_NEUTRAL}>
                            {t('cost.calculator.chips.multiplierNa')}
                          </span>
                        )}
                      {row.perRequest.flags.noCachedRate && (
                        <span className={ADMIN_CHIP_NEUTRAL}>
                          {t('cost.calculator.chips.noCachedRate')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={TD_NUM}>
                    {perRequestText(row.perRequest.total)}
                  </td>
                  <td className={TD_NUM}>{numberFormat.format(requests)}</td>
                  <td className={TD_NUM}>{usd(spend)}</td>
                  <td className={TD_NUM}>{usd(spend * annualFactor)}</td>
                </tr>
              );
            })}
            {entered.excluded.map((row) => (
              <tr
                key={`excluded-${row.modelId}`}
                className="border-t border-gray-200 dark:border-gray-700"
              >
                <td className={TD}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {label(row.modelId)}
                    <span className={LIMITS_CHIP_WARN}>
                      {t('cost.calculator.chips.excluded', {
                        reason: t(
                          `cost.calculator.excluded.${row.reason}` as never,
                        ),
                      })}
                    </span>
                  </span>
                </td>
                <td className={TD_NUM}>{t('cost.calculator.noPrice')}</td>
                <td className={TD_NUM}>—</td>
                <td className={TD_NUM}>—</td>
                <td className={TD_NUM}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {entered.incomplete && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300"
        >
          <IconAlertTriangle size={14} aria-hidden="true" />
          {t('cost.calculator.incomplete', { count: entered.excluded.length })}
        </p>
      )}

      {/* Totals + breakdown */}
      <dl
        className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
        data-testid="cost-totals"
      >
        <Total
          label={t('cost.calculator.totalPerRequest')}
          value={perRequestText(entered.perRequest.total)}
        />
        <Total
          label={t('cost.calculator.totalPerUser', { period: periodLabel })}
          value={usd(entered.perUserPerPeriod.total)}
        />
        <Total
          label={t('cost.calculator.totalPerPeriod', { period: periodLabel })}
          value={usd(entered.totalPerPeriod.total)}
        />
        <Total
          label={t('cost.calculator.annualized')}
          value={usd(entered.annualized.total)}
        />
      </dl>
      <p className={ADMIN_MUTED}>
        {t('cost.calculator.breakdown', {
          input: usd(entered.totalPerPeriod.input),
          cached: usd(entered.totalPerPeriod.cachedInput),
          output: usd(entered.totalPerPeriod.output),
          period: periodLabel,
        })}
      </p>

      {/* Cross-check */}
      <div className={LIMITS_NOTE_CARD} data-testid="cost-cross-check">
        <p className="font-medium">{t('cost.calculator.crossCheckTitle')}</p>
        <p className="mt-1">
          {t('cost.calculator.impliedPerDay', {
            requests: numberFormat.format(impliedRequestsPerUserPerDay),
          })}
        </p>
        <CrossCheckVerdict
          entered={entered}
          ceiling={ceiling}
          capBinding={capBinding}
          bindingCells={bindingCells}
          usd={usd}
          periodLabel={periodLabel}
          t={t}
        />
        {cells.length > 0 && (
          <div className="mt-2">
            <p className={ADMIN_MUTED}>{t('cost.calculator.capsConsidered')}</p>
            <ul className="mt-1 space-y-0.5">
              {cells.map((cell) => (
                <li key={cell.cell} className={ADMIN_MUTED}>
                  <CellLine cell={cell} catalog={catalog} t={t} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {anyMonthCell && (
          <p className={`mt-2 ${ADMIN_MUTED}`}>
            {t('cost.calculator.approximateMonth')}
          </p>
        )}
        <p className={`mt-2 ${ADMIN_MUTED}`}>
          {mode === 'scoped'
            ? t('cost.calculator.scopedNote')
            : t('cost.calculator.draftNote')}
        </p>
      </div>

      {/* Disclosure — every surface that shows a number carries it. */}
      <p className={ADMIN_MUTED} data-testid="cost-disclosure">
        {t('cost.calculator.disclosure', {
          asOf: entered.assumptions.pricingAsOf,
          multiplier: String(
            COST_ASSUMPTIONS.deploymentMultipliers[
              entered.assumptions.deployment
            ],
          ),
          deployment: t(
            `cost.calculator.deploymentOptions.${entered.assumptions.deployment}` as never,
          ),
          promptTokens: String(entered.assumptions.profile.promptTokens),
          completionTokens: String(
            entered.assumptions.profile.completionTokens,
          ),
          cachedPercent: String(
            Math.round(entered.assumptions.profile.cachedShare * 100),
          ),
          toolRounds: String(entered.assumptions.toolRounds),
          version: entered.assumptions.assumptionsVersion,
          pricingVersion: entered.assumptions.pricingAssumptionsVersion,
        })}
      </p>
    </div>
  );
};

const Total: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
    <dd className="tabular-nums font-medium text-black dark:text-white">
      {value}
    </dd>
  </div>
);

interface VerdictProps {
  entered: EstimateResult;
  ceiling: EstimateResult;
  capBinding: boolean;
  bindingCells: string[];
  usd: (value: number) => string;
  periodLabel: string;
  t: Translate;
}

/**
 * Within caps / would bind. `bindingCells` names the cells that SHAPE the
 * ceiling even when the entered load fits (design worked example 10), so the
 * capped ceiling is shown whenever any cell bounds the mix; `capBinding`
 * alone says the entered requests exceed it.
 */
const CrossCheckVerdict: FC<VerdictProps> = ({
  entered,
  ceiling,
  capBinding,
  bindingCells,
  usd,
  periodLabel,
  t,
}) => {
  if (bindingCells.length === 0) {
    return (
      <p className="mt-1" data-testid="cost-verdict-unbounded">
        {t('cost.calculator.withinCapsUnbounded')}
      </p>
    );
  }
  const blocked = ceiling.requestsPerUserPerPeriod === 0;
  return (
    <div className="mt-1 space-y-1">
      <p
        className={
          capBinding ? 'text-amber-800 dark:text-amber-300' : undefined
        }
        data-testid={
          capBinding ? 'cost-verdict-binding' : 'cost-verdict-within'
        }
      >
        {capBinding
          ? t('cost.calculator.capBinds', {
              cells: bindingCells.join(', '),
              requests: usdFree(ceiling.requestsPerUserPerPeriod),
              period: periodLabel,
            })
          : t('cost.calculator.withinCaps', {
              cells: bindingCells.join(', '),
            })}
      </p>
      <p>
        {blocked
          ? t('cost.calculator.blocked')
          : t('cost.calculator.cappedSpend', {
              amount: usd(ceiling.totalPerPeriod.total),
              period: periodLabel,
              annual: usd(ceiling.annualized.total),
              entered: usd(entered.totalPerPeriod.total),
            })}
      </p>
    </div>
  );
};

/** Requests are plain numbers, never money — one decimal is plenty. */
function usdFree(requests: number): string {
  return String(Math.round(requests * 10) / 10);
}

const CellLine: FC<{
  cell: CrossCheckCell;
  catalog: ReturnType<typeof buildQualifierCatalog>;
  t: Translate;
}> = ({ cell, catalog, t }) => {
  const qualifier =
    cell.modelId || cell.series
      ? ` · ${qualifierLabel(catalog, { modelId: cell.modelId, series: cell.series })}`
      : '';
  let value: string;
  if (cell.unit === 'boolean') {
    // A gate (model.allowed) is allowed or blocked — never "unlimited", the
    // counter word; same vocabulary as the effective-limits preview.
    value =
      cell.value === false || cell.value === 0
        ? t('modeBlocked')
        : t('modeAllowed');
  } else if (cell.value === null || cell.value === true) {
    value = t('cost.calculator.cellUnlimited');
  } else if (cell.value === false || cell.value === 0) {
    value = t('cost.calculator.cellBlocked');
  } else {
    value = t('cost.calculator.cellValue', {
      value: String(cell.value),
      unit: t(`unit.${cell.unit}` as never),
      window:
        cell.window === 'day' || cell.window === 'month'
          ? t(`window.${cell.window}` as never)
          : '',
    });
  }
  return (
    <>
      <span className="font-mono">{cell.cell}</span>
      {qualifier}: {value}
    </>
  );
};
