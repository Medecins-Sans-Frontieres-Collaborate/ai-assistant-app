'use client';

import { IconDownload } from '@tabler/icons-react';
import { FC, useId, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { ColumnView } from '@/lib/services/analytics/previewModel';
import { Cell } from '@/lib/services/analytics/tables';
import {
  AggFn,
  dateSeries,
  groupByAgg,
} from '@/lib/services/workflows/data/aggregate';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { saveChart } from '@/components/Analytics/chartExport';
import { BarChartSvg } from '@/components/Workflows/Data/charts/BarChartSvg';
import { LineChartSvg } from '@/components/Workflows/Data/charts/LineChartSvg';

const MEASURE_AGGREGATIONS: AggFn[] = ['sum', 'mean', 'min', 'max'];
/** Bars drawn; the rest of the groups are left out, largest first. */
const MAX_GROUPS = 30;
const ROW_COUNT = '';

const key = (index: number) => `c${index}`;

interface QuickChartProps {
  tableName: string;
  columns: ColumnView[];
  rows: Cell[][];
  /** Set when the table holds more rows than were loaded. */
  partial: { shown: number; total: number } | null;
}

/**
 * One chart from one table: pick what to group by and what to measure.
 * Deterministic, client-side aggregation over the rows already on screen —
 * a category column draws bars, a date column draws a line.
 *
 * Columns users do not get are left out of the pickers even for admins: a
 * chart is the thing most likely to be saved and passed on.
 */
export const QuickChart: FC<QuickChartProps> = ({
  tableName,
  columns,
  rows,
  partial,
}) => {
  const t = useTranslations('analytics');
  const id = useId();

  const usable = useMemo(
    () =>
      columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => !column.hiddenFromUsers),
    [columns],
  );
  const groupOptions = usable.filter(
    ({ column }) => column.kind === 'text' || column.kind === 'date',
  );
  const measureOptions = usable.filter(
    ({ column }) => column.kind === 'number',
  );

  const [groupChoice, setGroupChoice] = useState<number | null>(null);
  const [measureChoice, setMeasureChoice] = useState<string>(ROW_COUNT);
  const [aggregation, setAggregation] = useState<AggFn>('sum');

  // Fall back when the chosen column is not in this table (tab switched).
  const group =
    groupOptions.find(({ index }) => index === groupChoice) ??
    groupOptions.find(({ column }) => column.kind === 'date') ??
    groupOptions[0];
  const measure = measureOptions.find(
    ({ index }) => String(index) === measureChoice,
  );

  if (!group) {
    return <p className={ADMIN_MUTED}>{t('chart.noColumns')}</p>;
  }

  const measureLabel = measure
    ? `${t(`chart.agg.${aggregation}`)} · ${measure.column.name}`
    : t('chart.rowCount');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${id}-group`} className={ADMIN_LABEL}>
            {t('chart.groupBy')}
          </label>
          <select
            id={`${id}-group`}
            className={`${ADMIN_FIELD} w-56`}
            value={group.index}
            onChange={(e) => setGroupChoice(Number(e.target.value))}
          >
            {groupOptions.map(({ column, index }) => (
              <option key={index} value={index}>
                {column.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-measure`} className={ADMIN_LABEL}>
            {t('chart.measure')}
          </label>
          <select
            id={`${id}-measure`}
            className={`${ADMIN_FIELD} w-56`}
            value={measure ? String(measure.index) : ROW_COUNT}
            onChange={(e) => setMeasureChoice(e.target.value)}
          >
            <option value={ROW_COUNT}>{t('chart.rowCount')}</option>
            {measureOptions.map(({ column, index }) => (
              <option key={index} value={index}>
                {column.name}
              </option>
            ))}
          </select>
        </div>
        {measure && (
          <div>
            <label htmlFor={`${id}-agg`} className={ADMIN_LABEL}>
              {t('chart.aggregation')}
            </label>
            <select
              id={`${id}-agg`}
              className={`${ADMIN_FIELD} w-40`}
              value={aggregation}
              onChange={(e) => setAggregation(e.target.value as AggFn)}
            >
              {MEASURE_AGGREGATIONS.map((agg) => (
                <option key={agg} value={agg}>
                  {t(`chart.agg.${agg}`)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <ChartFigure
        rows={rows}
        groupIndex={group.index}
        groupIsDate={group.column.kind === 'date'}
        measureIndex={measure ? measure.index : null}
        aggregation={aggregation}
        title={t('chart.ariaLabel', {
          measure: measureLabel,
          group: group.column.name,
        })}
        fileStem={`${tableName}_${group.column.name}`}
      />

      {partial && (
        <p className={ADMIN_MUTED}>
          {t('chart.basedOn', { shown: partial.shown, total: partial.total })}
        </p>
      )}
    </div>
  );
};

interface ChartFigureProps {
  rows: Cell[][];
  groupIndex: number;
  groupIsDate: boolean;
  /** null → count rows. */
  measureIndex: number | null;
  aggregation: AggFn;
  title: string;
  fileStem: string;
}

/** The aggregation and the drawing, for one fixed set of choices. */
const ChartFigure: FC<ChartFigureProps> = ({
  rows,
  groupIndex,
  groupIsDate,
  measureIndex,
  aggregation,
  title,
  fileStem,
}) => {
  const t = useTranslations('analytics');
  const frameRef = useRef<HTMLElement>(null);

  const chart = useMemo(() => {
    const records = rows.map((row) =>
      Object.fromEntries(row.map((cell, index) => [key(index), cell])),
    );
    const agg: AggFn = measureIndex === null ? 'count' : aggregation;
    const valueColumn = measureIndex === null ? undefined : key(measureIndex);
    if (groupIsDate) {
      return {
        kind: 'line' as const,
        points: dateSeries(records, key(groupIndex), agg, valueColumn),
      };
    }
    return {
      kind: 'bar' as const,
      data: groupByAgg(records, key(groupIndex), agg, valueColumn, MAX_GROUPS),
    };
  }, [rows, groupIndex, groupIsDate, measureIndex, aggregation]);

  const isEmpty =
    chart.kind === 'line'
      ? chart.points.length === 0
      : chart.data.groups.length === 0;
  if (isEmpty) return <p className={ADMIN_MUTED}>{t('chart.empty')}</p>;

  const save = async (format: 'svg' | 'png') => {
    const svg = frameRef.current?.querySelector('svg');
    if (!svg) return;
    try {
      await saveChart(svg, fileStem, format);
    } catch {
      toast.error(t('chart.saveFailed'));
    }
  };

  return (
    <>
      <figure
        ref={frameRef}
        className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-surface-dark"
      >
        <figcaption className="mb-2 text-sm font-medium text-black dark:text-white">
          {title}
        </figcaption>
        {chart.kind === 'line' ? (
          <LineChartSvg points={chart.points} ariaLabel={title} />
        ) : (
          <BarChartSvg data={chart.data} ariaLabel={title} />
        )}
      </figure>
      {chart.kind === 'bar' && chart.data.truncated && (
        <p className={ADMIN_MUTED}>
          {t('chart.truncatedGroups', { count: MAX_GROUPS })}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => save('png')}
        >
          <IconDownload size={16} aria-hidden="true" />
          {t('chart.savePng')}
        </button>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => save('svg')}
        >
          <IconDownload size={16} aria-hidden="true" />
          {t('chart.saveSvg')}
        </button>
      </div>
    </>
  );
};
