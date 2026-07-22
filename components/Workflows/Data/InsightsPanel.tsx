'use client';

import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  AggFn,
  dateSeries,
  dateSeriesSplit,
  groupByAgg,
  groupBySplit,
  histogram,
  pivotTable,
  scatterPoints,
} from '@/lib/services/workflows/data/aggregate';

import { DataColumn } from '@/types/workflow';

import { PivotTable } from './PivotTable';
import { BarChartSvg } from './charts/BarChartSvg';
import { ChartLegend } from './charts/ChartLegend';
import { GroupedBarChartSvg } from './charts/GroupedBarChartSvg';
import { HistogramSvg } from './charts/HistogramSvg';
import { LineChartSvg } from './charts/LineChartSvg';
import { MultiLineChartSvg } from './charts/MultiLineChartSvg';
import { ScatterSvg } from './charts/ScatterSvg';
import { MAX_SERIES } from './charts/palette';

type ChartKind = 'bar' | 'histogram' | 'line' | 'scatter' | 'pivot';

interface InsightsPanelProps {
  columns: DataColumn[];
  /** The rows in view — filters apply to insights immediately. */
  rows: Record<string, unknown>[];
}

const selectClasses =
  'min-h-[32px] rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300';

const KIND_LABEL_KEYS: Record<ChartKind, string> = {
  bar: 'chartBar',
  histogram: 'chartHistogram',
  line: 'chartLine',
  scatter: 'chartScatter',
  pivot: 'chartPivot',
};

const AGG_OPTIONS: Array<{ value: AggFn; labelKey: string }> = [
  { value: 'sum', labelKey: 'aggSum' },
  { value: 'mean', labelKey: 'aggMean' },
  { value: 'min', labelKey: 'aggMin' },
  { value: 'max', labelKey: 'aggMax' },
  { value: 'median', labelKey: 'aggMedian' },
];

/**
 * Quick deterministic charts and summaries (group-by bar with optional
 * split series, numeric histogram, date line, x/y scatter, group-by
 * pivot table) over the VISIBLE rows — no LLM involved, config is
 * ephemeral. Sits between grid and transform bar so chart and filtered
 * grid are seen together.
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
    if (numberColumns.length >= 2) kinds.push('scatter');
    if (groupColumns.length > 0) kinds.push('pivot');
    return kinds;
  }, [groupColumns, numberColumns, dateColumns]);

  const [kind, setKind] = useState<ChartKind | null>(null);
  const [groupColumnId, setGroupColumnId] = useState<string | null>(null);
  const [numberColumnId, setNumberColumnId] = useState<string | null>(null);
  const [dateColumnId, setDateColumnId] = useState<string | null>(null);
  const [agg, setAgg] = useState<AggFn>('count');
  const [valueColumnId, setValueColumnId] = useState<string | null>(null);
  const [xColumnId, setXColumnId] = useState<string | null>(null);
  const [yColumnId, setYColumnId] = useState<string | null>(null);
  /** '' / unresolvable = no split. */
  const [splitColumnId, setSplitColumnId] = useState<string>('');
  /** null = never chosen → default to the first numeric columns. */
  const [pivotValueIds, setPivotValueIds] = useState<string[] | null>(null);

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
  const activeX =
    numberColumns.find((c) => c.id === xColumnId) ?? numberColumns[0];
  const activeY =
    numberColumns.find((c) => c.id === yColumnId) ??
    numberColumns.find((c) => c.id !== activeX?.id) ??
    numberColumns[0];
  // The bar chart's own group column can't also be the split.
  const splitCandidates = useMemo(
    () =>
      groupColumns.filter(
        (c) => activeKind !== 'bar' || c.id !== activeGroup?.id,
      ),
    [groupColumns, activeKind, activeGroup],
  );
  const activeSplit = useMemo(
    () => splitCandidates.find((c) => c.id === splitColumnId),
    [splitCandidates, splitColumnId],
  );
  /** Pivot forces count when no numeric columns exist. */
  const pivotAgg: AggFn = numberColumns.length === 0 ? 'count' : agg;
  const activePivotValues = useMemo(
    () =>
      pivotAgg === 'count'
        ? []
        : pivotValueIds === null
          ? numberColumns.slice(0, 3)
          : numberColumns.filter((c) => pivotValueIds.includes(c.id)),
    [pivotAgg, pivotValueIds, numberColumns],
  );

  const barData = useMemo(
    () =>
      activeKind === 'bar' && activeGroup && !activeSplit
        ? groupByAgg(rows, activeGroup.id, effectiveAgg, activeValue?.id)
        : null,
    [activeKind, activeGroup, activeSplit, rows, effectiveAgg, activeValue],
  );
  const barSplitData = useMemo(
    () =>
      activeKind === 'bar' && activeGroup && activeSplit
        ? groupBySplit(
            rows,
            activeGroup.id,
            activeSplit.id,
            effectiveAgg,
            activeValue?.id,
            12,
            MAX_SERIES,
          )
        : null,
    [activeKind, activeGroup, activeSplit, rows, effectiveAgg, activeValue],
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
      activeKind === 'line' && activeDate && !activeSplit
        ? dateSeries(rows, activeDate.id, effectiveAgg, activeValue?.id)
        : null,
    [activeKind, activeDate, activeSplit, rows, effectiveAgg, activeValue],
  );
  const lineSplitData = useMemo(
    () =>
      activeKind === 'line' && activeDate && activeSplit
        ? dateSeriesSplit(
            rows,
            activeDate.id,
            activeSplit.id,
            effectiveAgg,
            activeValue?.id,
            300,
            MAX_SERIES,
          )
        : null,
    [activeKind, activeDate, activeSplit, rows, effectiveAgg, activeValue],
  );
  const scatterData = useMemo(
    () =>
      activeKind === 'scatter' && activeX && activeY
        ? scatterPoints(rows, activeX.id, activeY.id)
        : null,
    [activeKind, activeX, activeY, rows],
  );
  const pivotData = useMemo(
    () =>
      activeKind === 'pivot' && activeGroup
        ? pivotTable(
            rows,
            activeGroup.id,
            pivotAgg,
            activePivotValues.map((c) => c.id),
          )
        : null,
    [activeKind, activeGroup, rows, pivotAgg, activePivotValues],
  );

  if (!activeKind) return null;

  const showAggControls =
    activeKind === 'bar' ||
    activeKind === 'line' ||
    (activeKind === 'pivot' && numberColumns.length > 0);
  const seriesKeys =
    barSplitData?.seriesKeys ?? lineSplitData?.seriesKeys ?? null;
  const isEmpty =
    (barData && barData.groups.length === 0) ||
    (barSplitData && barSplitData.groups.length === 0) ||
    (histogramData && histogramData.length === 0) ||
    (lineData && lineData.length === 0) ||
    (lineSplitData && lineSplitData.points.length === 0) ||
    (scatterData && scatterData.points.length === 0) ||
    (pivotData && pivotData.rows.length === 0);

  return (
    <div
      className={`flex shrink-0 flex-col border-t border-gray-200 dark:border-gray-700 ${
        activeKind === 'pivot' ? 'h-80' : 'h-64'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <select
          value={activeKind}
          onChange={(e) => setKind(e.target.value as ChartKind)}
          aria-label={t('chartKind')}
          className={selectClasses}
        >
          {availableKinds.map((k) => (
            <option key={k} value={k}>
              {t(KIND_LABEL_KEYS[k])}
            </option>
          ))}
        </select>

        {(activeKind === 'bar' || activeKind === 'pivot') && activeGroup && (
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
        {activeKind === 'scatter' && activeX && activeY && (
          <>
            <select
              value={activeX.id}
              onChange={(e) => setXColumnId(e.target.value)}
              aria-label={t('xColumn')}
              className={selectClasses}
            >
              {numberColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={activeY.id}
              onChange={(e) => setYColumnId(e.target.value)}
              aria-label={t('yColumn')}
              className={selectClasses}
            >
              {numberColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}

        {showAggControls && (
          <>
            <select
              value={activeKind === 'pivot' ? pivotAgg : effectiveAgg}
              onChange={(e) => setAgg(e.target.value as AggFn)}
              aria-label={t('aggFn')}
              className={selectClasses}
            >
              <option value="count">{t('aggCount')}</option>
              {numberColumns.length > 0 &&
                AGG_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
            </select>
            {activeKind !== 'pivot' &&
              effectiveAgg !== 'count' &&
              activeValue && (
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

        {(activeKind === 'bar' || activeKind === 'line') &&
          splitCandidates.length > 0 && (
            <select
              value={activeSplit?.id ?? ''}
              onChange={(e) => setSplitColumnId(e.target.value)}
              aria-label={t('splitByColumn')}
              className={selectClasses}
            >
              <option value="">{t('splitNone')}</option>
              {splitCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}

        {activeKind === 'pivot' && pivotAgg !== 'count' && (
          <span
            role="group"
            aria-label={t('pivotValueColumns')}
            className="flex flex-wrap items-center gap-1.5"
          >
            {numberColumns.map((c) => {
              const checked = activePivotValues.some(
                (active) => active.id === c.id,
              );
              return (
                <label
                  key={c.id}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border px-1.5 py-0.5 text-xs ${
                    checked
                      ? 'border-blue-400 text-blue-700 dark:border-blue-600 dark:text-blue-300'
                      : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setPivotValueIds(
                        checked
                          ? activePivotValues
                              .filter((active) => active.id !== c.id)
                              .map((active) => active.id)
                          : [...activePivotValues.map((a) => a.id), c.id],
                      )
                    }
                    className="sr-only"
                  />
                  {c.name}
                </label>
              );
            })}
          </span>
        )}

        {(barData?.truncated || barSplitData?.truncatedGroups) && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('chartTruncated', { max: barSplitData ? '12' : '30' })}
          </span>
        )}
        {pivotData?.truncated && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('chartTruncated', { max: '100' })}
          </span>
        )}
        {(barSplitData?.truncatedSeries || lineSplitData?.truncatedSeries) && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('chartSeriesTruncated', { max: String(MAX_SERIES) })}
          </span>
        )}
        {scatterData?.truncated && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('chartPointsTruncated', { max: '1000' })}
          </span>
        )}
      </div>

      {seriesKeys && seriesKeys.length > 0 && (
        <div className="px-3 pt-1">
          <ChartLegend seriesKeys={seriesKeys} />
        </div>
      )}

      <div className="min-h-0 flex-1 px-3 pb-2">
        {barData && barData.groups.length > 0 && (
          <BarChartSvg
            data={barData}
            ariaLabel={t('chartBarAria', {
              column: activeGroup?.name ?? '',
            })}
          />
        )}
        {barSplitData && barSplitData.groups.length > 0 && (
          <GroupedBarChartSvg
            data={barSplitData}
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
        {lineSplitData && lineSplitData.points.length > 0 && (
          <MultiLineChartSvg
            data={lineSplitData}
            ariaLabel={t('chartLineAria', {
              column: activeDate?.name ?? '',
            })}
          />
        )}
        {scatterData && scatterData.points.length > 0 && activeX && activeY && (
          <ScatterSvg
            points={scatterData.points}
            ariaLabel={t('chartScatterAria', {
              x: activeX.name,
              y: activeY.name,
            })}
          />
        )}
        {pivotData && pivotData.rows.length > 0 && activeGroup && (
          <PivotTable
            data={pivotData}
            groupColumn={activeGroup}
            valueColumns={activePivotValues}
            agg={pivotAgg}
            ariaLabel={t('pivotTableAria', { column: activeGroup.name })}
          />
        )}
        {isEmpty && (
          <p className="pt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('chartNoData')}
          </p>
        )}
      </div>
    </div>
  );
}
