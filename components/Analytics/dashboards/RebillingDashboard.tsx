'use client';

import { FC } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { RollupView } from '@/lib/services/analytics/rollupModel';

import {
  PanelGate,
  PanelGrid,
  barsOf,
  readDataset,
} from '@/components/Analytics/dashboards/shared';
import {
  BarList,
  DivergingBarList,
  foldTail,
  mergeByLabel,
} from '@/components/Charts/BarList';
import { ChartCard } from '@/components/Charts/ChartCard';
import { StatRow, StatTile } from '@/components/Charts/StatTile';
import { formatCompact, formatFull } from '@/components/Charts/format';

const TOP = 10;

/**
 * A rebilling file: what the platform cost in the period and how that was
 * shared between sections.
 *
 * Two sections usually carry most of the bill and a long tail carries almost
 * none, so the ranking shows the largest and folds the rest into one row —
 * the table view has every section.
 */
export const RebillingDashboard: FC<{ view: RollupView }> = ({ view }) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const { kpis, text } = view;
  const currency = text.currency ?? '';
  // Money is shown in full: a bill of 10,957.01 is not "11K".
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : formatFull(value, locale);
  const count = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : formatCompact(value, locale);
  const smallGroups = t('smallGroups');
  const rest = (count: number) => t('otherCount', { count });

  const sections = readDataset(view, 'bySection');
  const reconciliation = readDataset(view, 'reconciliation');
  const changes = readDataset(view, 'changes');
  const domains = readDataset(view, 'byDomain');
  const changed = changes
    ? changes.rows
        .filter((row) => changes.num(row, 'change') !== 0)
        .sort(
          (a, b) =>
            Math.abs(changes.num(b, 'change')) -
            Math.abs(changes.num(a, 'change')),
        )
    : [];

  return (
    <div className="space-y-4">
      <StatRow>
        <StatTile
          label={t('rebilling.totalBilled')}
          value={money(kpis.totalBilled)}
          unit={currency}
        />
        <StatTile
          label={t('rebilling.usageVariable')}
          value={money(kpis.usageVariable)}
          unit={currency}
        />
        <StatTile
          label={t('rebilling.staticInfra')}
          value={money(kpis.staticInfrastructure)}
          unit={currency}
        />
        <StatTile
          label={t('rebilling.sections')}
          value={count(kpis.sections)}
        />
        <StatTile
          label={t('rebilling.usageEvents')}
          value={count(kpis.usageEvents)}
        />
      </StatRow>

      <PanelGrid>
        <PanelGate
          view={view}
          needs={['bySection']}
          title={t('rebilling.bySection')}
        >
          {sections && (
            <ChartCard
              title={t('rebilling.bySection')}
              subtitle={currency}
              table={{
                columns: [
                  t('rebilling.col.section'),
                  t('rebilling.col.usageEvents'),
                  t('rebilling.col.usagePct'),
                  t('rebilling.col.billed'),
                ],
                rows: sections.rows.map((row) => [
                  sections.text(row, 'section'),
                  sections.maybeNum(row, 'usageEvents'),
                  sections.maybeNum(row, 'usagePct'),
                  sections.num(row, 'billed'),
                ]),
              }}
            >
              <BarList
                ariaLabel={t('rebilling.bySection')}
                items={foldTail(
                  barsOf(sections, 'billed', smallGroups, 'section'),
                  TOP,
                  rest,
                )}
              />
            </ChartCard>
          )}
        </PanelGate>

        <PanelGate
          view={view}
          needs={['changes']}
          title={t('rebilling.changes')}
        >
          {changes && (
            <ChartCard
              title={t('rebilling.changes')}
              subtitle={currency}
              table={{
                columns: [
                  t('rebilling.col.section'),
                  t('rebilling.col.previous'),
                  t('rebilling.col.restated'),
                  t('rebilling.col.change'),
                ],
                rows: changes.rows.map((row) => [
                  changes.text(row, 'section'),
                  changes.maybeNum(row, 'previous'),
                  changes.maybeNum(row, 'restated'),
                  changes.num(row, 'change'),
                ]),
              }}
            >
              {changed.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t('rebilling.noChanges')}
                </p>
              ) : (
                <DivergingBarList
                  ariaLabel={t('rebilling.changes')}
                  items={changed.slice(0, TOP).map((row) => ({
                    label: changes.text(row, 'section'),
                    value: changes.num(row, 'change'),
                  }))}
                />
              )}
            </ChartCard>
          )}
        </PanelGate>

        <PanelGate
          view={view}
          needs={['byDomain']}
          title={t('rebilling.byDomain')}
        >
          {domains && (
            <ChartCard
              title={t('rebilling.byDomain')}
              note={domains.folded ? t('foldedNote') : undefined}
              table={{
                columns: [
                  t('rebilling.col.domain'),
                  t('rebilling.col.section'),
                  t('rebilling.col.users'),
                  t('rebilling.col.usageEvents'),
                ],
                rows: barsOf(domains, 'usageEvents', smallGroups).map(
                  (item, i) => [
                    item.label,
                    domains.text(domains.rows[i], 'section'),
                    domains.num(domains.rows[i], 'users'),
                    item.value,
                  ],
                ),
              }}
            >
              <BarList
                ariaLabel={t('rebilling.byDomain')}
                items={foldTail(
                  // One bar per domain: a domain split across sections, or
                  // several folded rows, is summed first.
                  mergeByLabel(barsOf(domains, 'usageEvents', smallGroups)),
                  TOP,
                  rest,
                )}
              />
            </ChartCard>
          )}
        </PanelGate>

        {/* Five lines of arithmetic: a table, not a chart. */}
        <PanelGate
          view={view}
          needs={['reconciliation']}
          title={t('rebilling.reconciliation')}
        >
          {reconciliation && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
              <p className="mb-3 text-sm font-semibold text-black dark:text-white">
                {t('rebilling.reconciliation')}
              </p>
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-gray-500 dark:text-gray-400">
                  <tr>
                    <th scope="col" className="py-1.5 font-medium">
                      {t('rebilling.col.line')}
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      {t('rebilling.col.amount')}
                      {currency ? ` (${currency})` : ''}
                    </th>
                  </tr>
                </thead>
                <tbody className="text-black dark:text-white">
                  {reconciliation.rows.map((row, i) => (
                    <tr
                      key={i}
                      className="border-t border-gray-100 dark:border-gray-800"
                    >
                      <td className="whitespace-pre-wrap py-1.5">
                        {reconciliation.text(row, 'line')}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {reconciliation.maybeNum(row, 'amount') === null
                          ? '—'
                          : formatFull(
                              reconciliation.num(row, 'amount'),
                              locale,
                            )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelGate>
      </PanelGrid>
    </div>
  );
};
