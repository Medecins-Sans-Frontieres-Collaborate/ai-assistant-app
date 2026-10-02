'use client';

import { FC } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { RollupView } from '@/lib/services/analytics/rollupModel';

import {
  PanelGate,
  PanelGrid,
  barsOf,
  readDataset,
  shortDay,
} from '@/components/Analytics/dashboards/shared';
import { BarList, foldTail } from '@/components/Charts/BarList';
import { ChartCard } from '@/components/Charts/ChartCard';
import { StatRow, StatTile } from '@/components/Charts/StatTile';
import { TimeChart } from '@/components/Charts/TimeChart';
import { formatCompact, formatFull } from '@/components/Charts/format';
import { OTHER, SERIES } from '@/components/Charts/palette';

/** Bars shown before the tail is folded into one row. */
const TOP = 12;

/**
 * A usage report: how many people used the assistant, how much, and how that
 * breaks down.
 *
 * Interactions and people are different scales, so they are two charts —
 * never one chart with two axes.
 */
export const UsageDashboard: FC<{ view: RollupView }> = ({ view }) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const { kpis, text } = view;
  const comparator = text.comparator ?? '';
  const figure = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : formatCompact(value, locale);
  const against = (value: number | null | undefined) =>
    value === null || value === undefined || comparator === ''
      ? undefined
      : t('usage.comparator', { comparator, value: formatFull(value, locale) });
  const smallGroups = t('smallGroups');
  const rest = (count: number) => t('otherCount', { count });

  const daily = readDataset(view, 'daily');
  const location = readDataset(view, 'dailyByLocation');
  const weekly = readDataset(view, 'weekly');
  const activity = readDataset(view, 'activity');

  const breakdown = (name: string, title: string, measure: string) => {
    const reader = readDataset(view, name);
    const items = reader ? barsOf(reader, measure, smallGroups) : [];
    return (
      <PanelGate view={view} needs={[name]} title={title}>
        {reader && (
          <ChartCard
            title={title}
            note={reader.folded ? t('foldedNote') : undefined}
            table={{
              columns: [
                t('usage.col.group'),
                t('usage.col.users'),
                t(`usage.col.${measure}`),
              ],
              rows: reader.rows.map((row, i) => [
                items[i].label,
                reader.num(row, 'users'),
                reader.num(row, measure),
              ]),
            }}
          >
            <BarList ariaLabel={title} items={foldTail(items, TOP, rest)} />
          </ChartCard>
        )}
      </PanelGate>
    );
  };

  return (
    <div className="space-y-4">
      <StatRow>
        <StatTile
          label={t('usage.users')}
          value={figure(kpis.users)}
          detail={
            kpis.shareUsers !== null && kpis.shareUsers !== undefined
              ? t('usage.shareUsers', { pct: kpis.shareUsers, comparator })
              : undefined
          }
        />
        <StatTile
          label={t('usage.interactions')}
          value={figure(kpis.interactions)}
          detail={
            kpis.shareUsage !== null && kpis.shareUsage !== undefined
              ? t('usage.shareUsage', { pct: kpis.shareUsage, comparator })
              : undefined
          }
        />
        <StatTile
          label={t('usage.avgPerUser')}
          value={figure(kpis.avgPerUser)}
          detail={against(kpis.all_avgPerUser)}
        />
        <StatTile
          label={t('usage.medianPerUser')}
          value={figure(kpis.medianPerUser)}
          detail={against(kpis.all_medianPerUser)}
        />
        <StatTile
          label={t('usage.hq')}
          value={figure(kpis.hqPct)}
          unit="%"
          detail={
            kpis.all_hqPct === null || kpis.all_hqPct === undefined
              ? undefined
              : t('usage.comparator', {
                  comparator,
                  value: `${formatFull(kpis.all_hqPct, locale)}%`,
                })
          }
        />
        <StatTile
          label={t('usage.field')}
          value={figure(kpis.fieldPct)}
          unit="%"
          detail={
            kpis.all_fieldPct === null || kpis.all_fieldPct === undefined
              ? undefined
              : t('usage.comparator', {
                  comparator,
                  value: `${formatFull(kpis.all_fieldPct, locale)}%`,
                })
          }
        />
      </StatRow>

      <PanelGrid>
        <PanelGate view={view} needs={['daily']} title={t('usage.daily')}>
          {daily && (
            <ChartCard
              title={t('usage.daily')}
              table={{
                columns: [t('usage.col.date'), t('usage.col.interactions')],
                rows: daily.rows.map((row) => [
                  shortDay(daily.text(row, 'date'), locale),
                  daily.num(row, 'interactions'),
                ]),
              }}
            >
              <TimeChart
                kind="column"
                ariaLabel={t('usage.daily')}
                categories={daily.rows.map((row) =>
                  shortDay(daily.text(row, 'date'), locale),
                )}
                series={[
                  {
                    name: t('usage.col.interactions'),
                    values: daily.rows.map((row) =>
                      daily.maybeNum(row, 'interactions'),
                    ),
                    color: SERIES[0],
                  },
                ]}
              />
            </ChartCard>
          )}
        </PanelGate>

        {/* By location when the field settings allow it; otherwise the plain
            count of people, which is still worth showing. */}
        {location ? (
          <ChartCard
            title={t('usage.dailyUsers')}
            subtitle={t('usage.dailyUsersSub')}
            table={{
              columns: [
                t('usage.col.date'),
                t('usage.location.hq'),
                t('usage.location.field'),
                t('usage.location.unknown'),
              ],
              rows: location.rows.map((row) => [
                shortDay(location.text(row, 'date'), locale),
                location.num(row, 'hq'),
                location.num(row, 'field'),
                location.num(row, 'unknown'),
              ]),
            }}
          >
            <TimeChart
              kind="column"
              ariaLabel={t('usage.dailyUsers')}
              totalLabel={t('usage.total')}
              categories={location.rows.map((row) =>
                shortDay(location.text(row, 'date'), locale),
              )}
              series={[
                {
                  name: t('usage.location.hq'),
                  values: location.rows.map((row) => location.num(row, 'hq')),
                  color: SERIES[0],
                },
                {
                  name: t('usage.location.field'),
                  values: location.rows.map((row) =>
                    location.num(row, 'field'),
                  ),
                  color: SERIES[1],
                },
                {
                  // Not a third category of person — the absence of one.
                  name: t('usage.location.unknown'),
                  values: location.rows.map((row) =>
                    location.num(row, 'unknown'),
                  ),
                  color: OTHER,
                },
              ]}
            />
          </ChartCard>
        ) : (
          <PanelGate
            view={view}
            needs={['daily']}
            title={t('usage.dailyUsers')}
          >
            {daily && (
              <ChartCard
                title={t('usage.dailyUsers')}
                table={{
                  columns: [t('usage.col.date'), t('usage.col.users')],
                  rows: daily.rows.map((row) => [
                    shortDay(daily.text(row, 'date'), locale),
                    daily.num(row, 'users'),
                  ]),
                }}
              >
                <TimeChart
                  kind="line"
                  ariaLabel={t('usage.dailyUsers')}
                  categories={daily.rows.map((row) =>
                    shortDay(daily.text(row, 'date'), locale),
                  )}
                  series={[
                    {
                      name: t('usage.col.users'),
                      values: daily.rows.map((row) =>
                        daily.maybeNum(row, 'users'),
                      ),
                      color: SERIES[0],
                    },
                  ]}
                />
              </ChartCard>
            )}
          </PanelGate>
        )}

        <PanelGate view={view} needs={['weekly']} title={t('usage.weekly')}>
          {weekly && (
            <ChartCard
              title={t('usage.weekly')}
              table={{
                columns: [
                  t('usage.col.week'),
                  t('usage.col.users'),
                  t('usage.col.interactions'),
                ],
                rows: weekly.rows.map((row) => [
                  shortDay(weekly.text(row, 'date'), locale),
                  weekly.num(row, 'users'),
                  weekly.num(row, 'interactions'),
                ]),
              }}
            >
              <TimeChart
                kind="column"
                ariaLabel={t('usage.weekly')}
                categories={weekly.rows.map((row) =>
                  shortDay(weekly.text(row, 'date'), locale),
                )}
                series={[
                  {
                    name: t('usage.col.interactions'),
                    values: weekly.rows.map((row) =>
                      weekly.maybeNum(row, 'interactions'),
                    ),
                    color: SERIES[0],
                  },
                ]}
              />
            </ChartCard>
          )}
        </PanelGate>

        <PanelGate view={view} needs={['activity']} title={t('usage.activity')}>
          {activity && (
            <ChartCard
              title={t('usage.activity')}
              subtitle={t('usage.activitySub')}
              table={{
                columns: [t('usage.col.band'), t('usage.col.users')],
                rows: activity.rows.map((row) => [
                  activity.text(row, 'band'),
                  activity.num(row, 'users'),
                ]),
              }}
            >
              <TimeChart
                kind="column"
                ariaLabel={t('usage.activity')}
                categories={activity.rows.map((row) =>
                  activity.text(row, 'band'),
                )}
                series={[
                  {
                    name: t('usage.col.users'),
                    values: activity.rows.map((row) =>
                      activity.num(row, 'users'),
                    ),
                    color: SERIES[0],
                  },
                ]}
              />
            </ChartCard>
          )}
        </PanelGate>

        {breakdown('byDepartment', t('usage.departments'), 'interactions')}
        {breakdown('byJobTitle', t('usage.jobTitles'), 'interactions')}
        {breakdown('byModel', t('usage.models'), 'events')}
      </PanelGrid>
    </div>
  );
};
