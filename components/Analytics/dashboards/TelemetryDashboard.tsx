'use client';

import { FC } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { RollupView } from '@/lib/services/analytics/rollupModel';

import {
  PanelGate,
  PanelGrid,
  barsOf,
  readDataset,
  scaled,
} from '@/components/Analytics/dashboards/shared';
import { BarList, foldTail } from '@/components/Charts/BarList';
import { ChartCard } from '@/components/Charts/ChartCard';
import { StatRow, StatTile } from '@/components/Charts/StatTile';
import { TimeChart } from '@/components/Charts/TimeChart';
import { formatCompact } from '@/components/Charts/format';
import { SERIES } from '@/components/Charts/palette';

const TOP = 10;

/**
 * One day of raw telemetry, for global admins: how busy the day was, what
 * failed, and where the tokens went. Aggregates only — nothing here names a
 * person, though the file it is computed from does.
 */
export const TelemetryDashboard: FC<{ view: RollupView }> = ({ view }) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const { kpis } = view;
  const figure = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : formatCompact(value, locale);
  const energy = scaled(kpis.energyWh ?? 0, 'Wh', 'kWh');
  const carbon = scaled(kpis.co2g ?? 0, 'g', 'kg');
  const smallGroups = t('smallGroups');
  const rest = (count: number) => t('otherCount', { count });
  const hourly = readDataset(view, 'hourly');

  const ranked = (name: string, title: string, measure: string) => {
    const reader = readDataset(view, name);
    return (
      <PanelGate view={view} needs={[name]} title={title}>
        {reader && (
          <ChartCard
            title={title}
            table={{
              columns: [
                t('telemetry.col.group'),
                t(`telemetry.col.${measure}`),
              ],
              rows: reader.rows.map((row) => [
                reader.text(row, 'group'),
                reader.num(row, measure),
              ]),
            }}
          >
            {reader.rows.length === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('telemetry.none')}
              </p>
            ) : (
              <BarList
                ariaLabel={title}
                items={foldTail(
                  barsOf(reader, measure, smallGroups),
                  TOP,
                  rest,
                )}
              />
            )}
          </ChartCard>
        )}
      </PanelGate>
    );
  };

  return (
    <div className="space-y-4">
      <StatRow>
        <StatTile label={t('telemetry.events')} value={figure(kpis.events)} />
        <StatTile label={t('telemetry.users')} value={figure(kpis.users)} />
        <StatTile label={t('telemetry.tokens')} value={figure(kpis.tokens)} />
        <StatTile label={t('telemetry.errors')} value={figure(kpis.errors)} />
        <StatTile
          label={t('telemetry.energy')}
          value={figure(energy.value)}
          unit={energy.unit}
        />
        <StatTile
          label={t('telemetry.co2')}
          value={figure(carbon.value)}
          unit={`${carbon.unit} CO₂e`}
        />
      </StatRow>

      <PanelGrid>
        <PanelGate view={view} needs={['hourly']} title={t('telemetry.hourly')}>
          {hourly && (
            <ChartCard
              title={t('telemetry.hourly')}
              table={{
                columns: [t('telemetry.col.hour'), t('telemetry.col.events')],
                rows: hourly.rows.map((row) => [
                  hourly.text(row, 'hour'),
                  hourly.num(row, 'events'),
                ]),
              }}
            >
              <TimeChart
                kind="column"
                ariaLabel={t('telemetry.hourly')}
                categories={hourly.rows.map((row) => hourly.text(row, 'hour'))}
                series={[
                  {
                    name: t('telemetry.col.events'),
                    values: hourly.rows.map((row) => hourly.num(row, 'events')),
                    color: SERIES[0],
                  },
                ]}
              />
            </ChartCard>
          )}
        </PanelGate>
        {ranked('byEventType', t('telemetry.byType'), 'events')}
        {ranked('byErrorCode', t('telemetry.byError'), 'events')}
        {ranked('byModel', t('telemetry.byModel'), 'tokens')}
        {ranked('byCompany', t('telemetry.byCompany'), 'events')}
      </PanelGrid>
    </div>
  );
};
