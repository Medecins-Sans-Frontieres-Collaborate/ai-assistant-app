'use client';

import { FC, useId, useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  FACTOR_FIELDS,
  bucketsOf,
  currentAppFactors,
  estimateBuckets,
  estimateByGroup,
  factorKey,
  readFactor,
  withFactor,
} from '@/lib/services/analytics/emissionsCalc';
import { SMALL_GROUPS_LABEL } from '@/lib/services/analytics/rollup';
import { RollupView } from '@/lib/services/analytics/rollupModel';

import { EmissionsFactors } from '@/lib/utils/shared/emissions';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
} from '@/components/Admin/adminClasses';
import {
  PanelGate,
  PanelGrid,
  scaled,
} from '@/components/Analytics/dashboards/shared';
import { BarItem, BarList, foldTail } from '@/components/Charts/BarList';
import { ChartCard } from '@/components/Charts/ChartCard';
import { StatRow, StatTile } from '@/components/Charts/StatTile';
import { formatCompact, formatFull } from '@/components/Charts/format';

const TOP = 12;
/** Fallback when the report does not state its own equivalence. */
const DEFAULT_CHARGE_GRAMS = 13.5;

type Basis = 'delivered' | 'current' | 'whatIf';

/**
 * An emissions report: energy and CO₂e for a period's usage.
 *
 * Every figure is CALCULATED here from the token counts the report carries,
 * under the assumption set the reader picks:
 *  - as delivered — the report's own assumptions, i.e. what its workbook says;
 *  - current app — the assumptions the app uses today;
 *  - what if — any of the above with figures changed, saved nowhere.
 *
 * So a change of assumptions needs no new delivery: the old report is simply
 * read again. The choice sits above everything it affects and every figure
 * below follows it.
 */
export const EmissionsDashboard: FC<{ view: RollupView }> = ({ view }) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const id = useId();
  const delivered = view.assumptions;
  const current = currentAppFactors();

  const [basis, setBasis] = useState<Basis>(
    delivered ? 'delivered' : 'current',
  );
  const [whatIf, setWhatIf] = useState<EmissionsFactors>(delivered ?? current);

  const factors: EmissionsFactors =
    basis === 'whatIf'
      ? whatIf
      : basis === 'delivered' && delivered
        ? delivered
        : current;

  const totals = useMemo(
    () => bucketsOf(view.datasets.recalc),
    [view.datasets],
  );
  const total = useMemo(
    () => estimateBuckets(totals, factors),
    [totals, factors],
  );
  const reference = useMemo(
    () => (delivered ? estimateBuckets(totals, delivered) : null),
    [totals, delivered],
  );

  const figure = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : formatCompact(value, locale);
  const energy = scaled(total.energyWh, 'Wh', 'kWh');
  const carbon = scaled(total.gCO2e, 'g', 'kg');
  const charges =
    total.gCO2e / (delivered?.smartphoneChargeGrams ?? DEFAULT_CHARGE_GRAMS);

  /** "+12% vs as delivered", or nothing when this IS as delivered. */
  const versusDelivered = (value: number, base: number | undefined) => {
    if (basis === 'delivered' || base === undefined) return undefined;
    if (base === 0 || Math.abs(value - base) / base < 0.0005) {
      return t('emissions.sameAsDelivered');
    }
    const pct = ((value - base) / base) * 100;
    return t('emissions.vsDelivered', {
      delta: `${pct > 0 ? '+' : '−'}${formatFull(Math.abs(pct), locale)}%`,
    });
  };

  const breakdown = (name: string, title: string) => {
    const dataset = view.datasets[name];
    const groups = dataset ? estimateByGroup(bucketsOf(dataset), factors) : [];
    const items: BarItem[] = groups.map((group) => ({
      label:
        group.group === SMALL_GROUPS_LABEL ? t('smallGroups') : group.group,
      value: group.gCO2e,
      muted: group.group === SMALL_GROUPS_LABEL,
    }));
    return (
      <PanelGate view={view} needs={[name]} title={title}>
        {dataset && (
          <ChartCard
            title={title}
            subtitle={t('emissions.gramsSub')}
            note={dataset.folded ? t('foldedNote') : undefined}
            table={{
              columns: [
                t('emissions.col.group'),
                t('emissions.col.requests'),
                t('emissions.col.tokens'),
                t('emissions.col.energyWh'),
                t('emissions.col.co2g'),
              ],
              rows: groups.map((group, i) => [
                items[i].label,
                group.requests,
                group.tokens,
                group.energyWh,
                group.gCO2e,
              ]),
            }}
          >
            <BarList
              ariaLabel={title}
              unit="g"
              items={foldTail(items, TOP, (count) =>
                t('otherCount', { count }),
              )}
            />
          </ChartCard>
        )}
      </PanelGate>
    );
  };

  const options: { value: Basis; label: string; disabled?: boolean }[] = [
    {
      value: 'delivered',
      label: t('emissions.delivered', {
        version: delivered?.assumptionsVersion ?? '—',
      }),
      disabled: !delivered,
    },
    {
      value: 'current',
      label: t('emissions.current', { version: current.assumptionsVersion }),
    },
    { value: 'whatIf', label: t('emissions.whatIf') },
  ];

  return (
    <div className="space-y-4">
      {/* The one control, above everything it scopes. */}
      <fieldset className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
        <legend className="px-1 text-sm font-semibold text-black dark:text-white">
          {t('emissions.assumptionsLabel')}
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {options.map((option) => (
            <label
              key={option.value}
              className={`flex items-center gap-2 text-sm ${
                option.disabled
                  ? 'text-gray-400 dark:text-gray-500'
                  : 'text-black dark:text-white'
              }`}
            >
              <input
                type="radio"
                name={`${id}-basis`}
                className="h-4 w-4 accent-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:accent-gray-400"
                checked={basis === option.value}
                disabled={option.disabled}
                onChange={() => {
                  // What-if starts from whatever was being looked at.
                  if (option.value === 'whatIf') setWhatIf(factors);
                  setBasis(option.value);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
        {!delivered && (
          <p className={`${ADMIN_BANNER_WARN} mt-3`} role="note">
            {t('emissions.deliveredUnavailable')}
          </p>
        )}

        {basis === 'whatIf' && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {t('emissions.whatIfIntro')}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FACTOR_FIELDS.map((field) => {
                const key = factorKey(field);
                return (
                  <div key={key}>
                    <label
                      htmlFor={`${id}-${key}`}
                      className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t(`emissions.factor.${field[0]}`, {
                        name: field[1] ?? '',
                      })}
                    </label>
                    <input
                      id={`${id}-${key}`}
                      type="number"
                      min={0}
                      step="any"
                      className={`${ADMIN_FIELD} w-full`}
                      value={readFactor(whatIf, field)}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value) && value >= 0) {
                          setWhatIf((previous) =>
                            withFactor(previous, field, value),
                          );
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() => setWhatIf(delivered ?? current)}
            >
              {delivered
                ? t('emissions.resetDelivered')
                : t('emissions.resetCurrent')}
            </button>
          </div>
        )}
      </fieldset>

      <StatRow>
        <StatTile
          label={t('emissions.co2')}
          value={figure(carbon.value)}
          unit={`${carbon.unit} CO₂e`}
          detail={versusDelivered(total.gCO2e, reference?.gCO2e)}
        />
        <StatTile
          label={t('emissions.energy')}
          value={figure(energy.value)}
          unit={energy.unit}
          detail={versusDelivered(total.energyWh, reference?.energyWh)}
        />
        <StatTile
          label={t('emissions.charges')}
          value={figure(charges)}
          detail={t('emissions.chargesSub')}
        />
        <StatTile
          label={t('emissions.activeUsers')}
          value={figure(view.kpis.activeUsers)}
        />
        <StatTile
          label={t('emissions.requests')}
          value={figure(view.kpis.requests)}
        />
        <StatTile label={t('emissions.tokens')} value={figure(total.tokens)} />
      </StatRow>

      {total.unpricedRequests > 0 && (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('emissions.unpriced', { count: total.unpricedRequests })}
        </p>
      )}

      <PanelGrid>
        {breakdown('byDepartment', t('emissions.byDepartment'))}
        {breakdown('byModel', t('emissions.byModel'))}

        {/* Three numbers and their difference: a table. */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
          <p className="text-sm font-semibold text-black dark:text-white">
            {t('emissions.reconciliation')}
          </p>
          <p className="mb-3 mt-0.5 text-xs text-gray-600 dark:text-gray-300">
            {t('emissions.reconciliationSub')}
          </p>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th scope="col" className="py-1.5 font-medium" />
                <th scope="col" className="py-1.5 text-right font-medium">
                  {t('emissions.col.energyWh')}
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  {t('emissions.col.co2g')}
                </th>
              </tr>
            </thead>
            <tbody className="text-black dark:text-white">
              {(
                [
                  [t('emissions.computed'), total.energyWh, total.gCO2e],
                  [
                    t('emissions.logged'),
                    view.kpis.loggedWh ?? 0,
                    view.kpis.loggedCO2g ?? 0,
                  ],
                  [
                    t('emissions.difference'),
                    total.energyWh - (view.kpis.loggedWh ?? 0),
                    total.gCO2e - (view.kpis.loggedCO2g ?? 0),
                  ],
                ] as [string, number, number][]
              ).map(([label, wh, grams]) => (
                <tr
                  key={label}
                  className="border-t border-gray-100 dark:border-gray-800"
                >
                  <th scope="row" className="py-1.5 font-normal">
                    {label}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatFull(wh, locale)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatFull(grams, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelGrid>
    </div>
  );
};
