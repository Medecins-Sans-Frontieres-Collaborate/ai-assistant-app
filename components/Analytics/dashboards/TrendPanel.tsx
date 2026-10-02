'use client';

import { FC, useMemo } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useAnalyticsTrend } from '@/client/hooks/analytics/useAnalytics';

import { AnalyticsTrendPoint } from '@/lib/services/analytics/dto';
import {
  bucketsOf,
  currentAppFactors,
  estimateBuckets,
} from '@/lib/services/analytics/emissionsCalc';

import { ADMIN_MUTED } from '@/components/Admin/adminClasses';
import {
  PanelGrid,
  readDataset,
  shortPeriod,
} from '@/components/Analytics/dashboards/shared';
import { ChartCard } from '@/components/Charts/ChartCard';
import { ChartSeries, TimeChart } from '@/components/Charts/TimeChart';
import { MAX_SERIES, OTHER, SERIES } from '@/components/Charts/palette';

interface TrendPanelProps {
  folder: string;
}

/**
 * The reports under a folder as a series over time.
 *
 * Shown only when the folder holds ONE run of reports — one per period. A
 * folder with a report per section for the same month is not a run, and the
 * panel says to open a section's folder rather than summing sections into a
 * series nobody delivered.
 */
export const TrendPanel: FC<TrendPanelProps> = ({ folder }) => {
  const t = useTranslations('analytics.dash');
  const trend = useAnalyticsTrend(folder, true);

  if (!trend.data) return null;
  if (trend.data.status === 'several-per-period') {
    return <p className={ADMIN_MUTED}>{t('trend.severalPerPeriod')}</p>;
  }
  if (trend.data.status !== 'ok') return null;

  const { points, reportType } = trend.data;
  return (
    <section aria-labelledby="analytics-trend-title" className="space-y-3">
      <h3
        id="analytics-trend-title"
        className="text-sm font-semibold text-gray-700 dark:text-gray-300"
      >
        {t('trend.title')}
      </h3>
      {reportType === 'usage' && <UsageTrend points={points} />}
      {reportType === 'rebilling' && <RebillingTrend points={points} />}
      {reportType === 'emissions' && <EmissionsTrend points={points} />}
    </section>
  );
};

interface TrendProps {
  points: AnalyticsTrendPoint[];
}

/** One measure per chart: people and interactions are different scales. */
function useSingleSeries(points: AnalyticsTrendPoint[], kpi: string) {
  const locale = useLocale();
  return {
    categories: points.map((point) => shortPeriod(point.period, locale)),
    values: points.map((point) => point.kpis[kpi] ?? null),
  };
}

const UsageTrend: FC<TrendProps> = ({ points }) => {
  const t = useTranslations('analytics.dash');
  const users = useSingleSeries(points, 'users');
  const interactions = useSingleSeries(points, 'interactions');
  return (
    <PanelGrid>
      <ChartCard
        title={t('trend.users')}
        table={{
          columns: [t('trend.period'), t('usage.col.users')],
          rows: users.categories.map((category, i) => [
            category,
            users.values[i],
          ]),
        }}
      >
        <TimeChart
          kind="line"
          ariaLabel={t('trend.users')}
          categories={users.categories}
          series={[
            {
              name: t('usage.col.users'),
              values: users.values,
              color: SERIES[0],
            },
          ]}
        />
      </ChartCard>
      <ChartCard
        title={t('trend.interactions')}
        table={{
          columns: [t('trend.period'), t('usage.col.interactions')],
          rows: interactions.categories.map((category, i) => [
            category,
            interactions.values[i],
          ]),
        }}
      >
        <TimeChart
          kind="line"
          ariaLabel={t('trend.interactions')}
          categories={interactions.categories}
          series={[
            {
              name: t('usage.col.interactions'),
              values: interactions.values,
              color: SERIES[0],
            },
          ]}
        />
      </ChartCard>
    </PanelGrid>
  );
};

const RebillingTrend: FC<TrendProps> = ({ points }) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const total = useSingleSeries(points, 'totalBilled');
  const currency = points[points.length - 1]?.text.currency ?? '';

  // The largest sections of the LATEST period keep their own line and their
  // own colour across every period; everything else is one grey line. Colour
  // follows the section, so an earlier month never repaints it.
  const sections = useMemo(() => {
    const perPoint = points.map((point) => {
      const reader = readDataset(point, 'bySection');
      return new Map(
        (reader?.rows ?? []).map((row) => [
          reader!.text(row, 'section'),
          reader!.num(row, 'billed'),
        ]),
      );
    });
    const latest = perPoint[perPoint.length - 1] ?? new Map<string, number>();
    const top = [...latest]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SERIES)
      .map(([name]) => name);
    const series: ChartSeries[] = top.map((name, slot) => ({
      name,
      values: perPoint.map((sectionsOf) => sectionsOf.get(name) ?? null),
      color: SERIES[slot],
    }));
    const hasOthers = perPoint.some((sectionsOf) =>
      [...sectionsOf.keys()].some((name) => !top.includes(name)),
    );
    if (hasOthers) {
      series.push({
        name: t('trend.otherSections'),
        values: perPoint.map((sectionsOf) =>
          sectionsOf.size === 0
            ? null
            : [...sectionsOf]
                .filter(([name]) => !top.includes(name))
                .reduce((sum, [, billed]) => sum + billed, 0),
        ),
        color: OTHER,
      });
    }
    return series;
  }, [points, t]);

  const categories = points.map((point) => shortPeriod(point.period, locale));

  return (
    <PanelGrid>
      <ChartCard
        title={t('trend.billed')}
        subtitle={currency}
        table={{
          columns: [t('trend.period'), t('rebilling.totalBilled')],
          rows: total.categories.map((category, i) => [
            category,
            total.values[i],
          ]),
        }}
      >
        <TimeChart
          kind="column"
          ariaLabel={t('trend.billed')}
          unit={currency}
          categories={total.categories}
          series={[
            {
              name: t('rebilling.totalBilled'),
              values: total.values,
              color: SERIES[0],
            },
          ]}
        />
      </ChartCard>
      {sections.length > 0 && (
        <ChartCard
          title={t('trend.sections')}
          subtitle={currency}
          table={{
            columns: [t('trend.period'), ...sections.map((s) => s.name)],
            rows: categories.map((category, i) => [
              category,
              ...sections.map((s) => s.values[i]),
            ]),
          }}
        >
          <TimeChart
            kind="line"
            ariaLabel={t('trend.sections')}
            unit={currency}
            categories={categories}
            series={sections}
          />
        </ChartCard>
      )}
    </PanelGrid>
  );
};

const EmissionsTrend: FC<TrendProps> = ({ points }) => {
  const t = useTranslations('analytics.dash');
  const locale = useLocale();
  const factors = currentAppFactors();
  // Every period under ONE assumption set — the app's current one — so that a
  // change of assumptions between two reports does not show up as a change
  // in emissions.
  const estimates = useMemo(
    () =>
      points.map((point) =>
        point.datasets.recalc
          ? estimateBuckets(bucketsOf(point.datasets.recalc), factors)
          : null,
      ),
    [points, factors],
  );
  const categories = points.map((point) => shortPeriod(point.period, locale));
  const kilograms = estimates.map((estimate) =>
    estimate ? estimate.gCO2e / 1000 : null,
  );
  const kilowattHours = estimates.map((estimate) =>
    estimate ? estimate.energyWh / 1000 : null,
  );
  const note = t('trend.recalculated', {
    version: factors.assumptionsVersion,
  });

  return (
    <PanelGrid>
      <ChartCard
        title={t('trend.co2')}
        subtitle="kg CO₂e"
        note={note}
        table={{
          columns: [t('trend.period'), 'kg CO₂e'],
          rows: categories.map((category, i) => [category, kilograms[i]]),
        }}
      >
        <TimeChart
          kind="line"
          ariaLabel={t('trend.co2')}
          unit="kg"
          categories={categories}
          series={[{ name: 'kg CO₂e', values: kilograms, color: SERIES[0] }]}
        />
      </ChartCard>
      <ChartCard
        title={t('trend.energy')}
        subtitle="kWh"
        note={note}
        table={{
          columns: [t('trend.period'), 'kWh'],
          rows: categories.map((category, i) => [category, kilowattHours[i]]),
        }}
      >
        <TimeChart
          kind="line"
          ariaLabel={t('trend.energy')}
          unit="kWh"
          categories={categories}
          series={[{ name: 'kWh', values: kilowattHours, color: SERIES[0] }]}
        />
      </ChartCard>
    </PanelGrid>
  );
};
