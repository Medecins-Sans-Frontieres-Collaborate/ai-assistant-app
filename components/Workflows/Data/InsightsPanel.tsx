'use client';

import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  AggFn,
  dateSeries,
  groupByAgg,
  histogram,
} from '@/lib/services/workflows/data/aggregate';

import { DataColumn } from '@/types/workflow';

import { BarChartSvg } from './charts/BarChartSvg';
import { HistogramSvg } from './charts/HistogramSvg';
import { LineChartSvg } from './charts/LineChartSvg';

type ChartKind = 'bar' | 'histogram' | 'line';

interface InsightsPanelProps {
  columns: DataColumn[];
  /** The rows in view — filters apply to insights immediately. */
  rows: Record<string, unknown>[];
}

const selectClasses =
  'min-h-[32px] rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300';

/**
 * Quick deterministic charts (group-by bar, numeric histogram, date
 * line) over the VISIBLE rows — no LLM involved, config is ephemeral.
 * Sits between grid and transform bar so chart and filtered grid are
 * seen together.
 */
export function InsightsPanel({ columns, rows }: InsightsPanelProps) {
  const t = useTranslations('workflows.data');

  const groupColumns = useMemo(
    () => columns.filter((c) => c.type === 'text' || c.type === 'boolean'),
    [columns],
  );
  const numberColumns = useMemo(
    () => columns.filter((c) => c.type === 'number'),
    [columns],
  );
  const dateColumns = useMemo(
    () => columns.filter((c) => c.type === 'date'),
    [columns],
  );

  const availableKinds = useMemo(() => {
    const kinds: ChartKind[] = [];
    if (groupColumns.length > 0) kinds.push('bar');
    if (numberColumns.length > 0) kinds.push('histogram');
    if (dateColumns.length > 0) kinds.push('line');
    return kinds;
  }, [groupColumns, numberColumns, dateColumns]);

  const [kind, setKind] = useState<ChartKind | null>(null);
  const [groupColumnId, setGroupColumnId] = useState<string | null>(null);
  const [numberColumnId, setNumberColumnId] = useState<string | null>(null);
  const [dateColumnId, setDateColumnId] = useState<string | null>(null);
  const [agg, setAgg] = useState<AggFn>('count');
  const [valueColumnId, setValueColumnId] = useState<string | null>(null);

  // Resolve config against what actually exists (columns change under us).
  const activeKind =
    kind && availableKinds.includes(kind) ? kind : (availableKinds[0] ?? null);
  const activeGroup =
    groupColumns.find((c) => c.id === groupColumnId) ?? groupColumns[0];
  const activeNumber =
    numberColumns.find((c) => c.id === numberColumnId) ?? numberColumns[0];
  const activeDate =
    dateColumns.find((c) => c.id === dateColumnId) ?? dateColumns[0];
  const activeValue =
    agg === 'count'
      ? undefined
      : (numberColumns.find((c) => c.id === valueColumnId) ?? numberColumns[0]);
  const effectiveAgg: AggFn = agg !== 'count' && !activeValue ? 'count' : agg;

  const barData = useMemo(
    () =>
      activeKind === 'bar' && activeGroup
        ? groupByAgg(rows, activeGroup.id, effectiveAgg, activeValue?.id)
        : null,
    [activeKind, activeGroup, rows, effectiveAgg, activeValue],
  );
  const histogramData = useMemo(
    () =>
      activeKind === 'histogram' && activeNumber
        ? histogram(rows, activeNumber.id)
        : null,
    [activeKind, activeNumber, rows],
  );
  const lineData = useMemo(
    () =>
      activeKind === 'line' && activeDate
        ? dateSeries(rows, activeDate.id, effectiveAgg, activeValue?.id)
        : null,
    [activeKind, activeDate, rows, effectiveAgg, activeValue],
  );

  if (!activeKind) return null;

  const showAggControls = activeKind === 'bar' || activeKind === 'line';

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-gray-200 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <select
          value={activeKind}
          onChange={(e) => setKind(e.target.value as ChartKind)}
          aria-label={t('chartKind')}
          className={selectClasses}
        >
          {availableKinds.map((k) => (
            <option key={k} value={k}>
              {t(
                k === 'bar'
                  ? 'chartBar'
                  : k === 'histogram'
                    ? 'chartHistogram'
                    : 'chartLine',
              )}
            </option>
          ))}
        </select>

        {activeKind === 'bar' && activeGroup && (
          <select
            value={activeGroup.id}
            onChange={(e) => setGroupColumnId(e.target.value)}
            aria-label={t('groupByColumn')}
            className={selectClasses}
          >
            {groupColumns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {activeKind === 'histogram' && activeNumber && (
          <select
            value={activeNumber.id}
            onChange={(e) => setNumberColumnId(e.target.value)}
            aria-label={t('valueColumn')}
            className={selectClasses}
          >
            {numberColumns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {activeKind === 'line' && activeDate && (
          <select
            value={activeDate.id}
            onChange={(e) => setDateColumnId(e.target.value)}
            aria-label={t('dateColumn')}
            className={selectClasses}
          >
            {dateColumns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        {showAggControls && (
          <>
            <select
              value={effectiveAgg}
              onChange={(e) => setAgg(e.target.value as AggFn)}
              aria-label={t('aggFn')}
              className={selectClasses}
            >
              <option value="count">{t('aggCount')}</option>
              {numberColumns.length > 0 && (
                <>
                  <option value="sum">{t('aggSum')}</option>
                  <option value="mean">{t('aggMean')}</option>
                </>
              )}
            </select>
            {effectiveAgg !== 'count' && activeValue && (
              <select
                value={activeValue.id}
                onChange={(e) => setValueColumnId(e.target.value)}
                aria-label={t('valueColumn')}
                className={selectClasses}
              >
                {numberColumns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}

        {barData?.truncated && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('chartTruncated', { max: '30' })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 px-3 pb-2">
        {barData && barData.groups.length > 0 && (
          <BarChartSvg
            data={barData}
            ariaLabel={t('chartBarAria', {
              column: activeGroup?.name ?? '',
            })}
          />
        )}
        {histogramData && histogramData.length > 0 && (
          <HistogramSvg
            bins={histogramData}
            ariaLabel={t('chartHistogramAria', {
              column: activeNumber?.name ?? '',
            })}
          />
        )}
        {lineData && lineData.length > 0 && (
          <LineChartSvg
            points={lineData}
            ariaLabel={t('chartLineAria', {
              column: activeDate?.name ?? '',
            })}
          />
        )}
        {((barData && barData.groups.length === 0) ||
          (histogramData && histogramData.length === 0) ||
          (lineData && lineData.length === 0)) && (
          <p className="pt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('chartNoData')}
          </p>
        )}
      </div>
    </div>
  );
}
