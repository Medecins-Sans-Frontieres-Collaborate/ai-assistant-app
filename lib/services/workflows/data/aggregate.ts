import { formatCell } from './tableUtils';

/**
 * Deterministic client-side aggregation for the insights panel and the
 * rail digest — the LLM never computes these. Pure, client-safe.
 */

export type AggFn = 'count' | 'sum' | 'mean' | 'min' | 'max' | 'median';

/** Shared per-bucket accumulator; values collected only for median. */
interface Acc {
  count: number;
  n: number;
  sum: number;
  min: number;
  max: number;
  values: number[] | null;
}

function newAcc(collectValues: boolean): Acc {
  return {
    count: 0,
    n: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    values: collectValues ? [] : null,
  };
}

function pushAcc(acc: Acc, value: number): void {
  acc.n += 1;
  acc.sum += value;
  if (value < acc.min) acc.min = value;
  if (value > acc.max) acc.max = value;
  acc.values?.push(value);
}

/** Null when a non-count aggregate has no numeric values. */
function finishAcc(acc: Acc, agg: AggFn): number | null {
  if (agg === 'count') return acc.count;
  if (acc.n === 0) return null;
  switch (agg) {
    case 'sum':
      return acc.sum;
    case 'mean':
      return acc.sum / acc.n;
    case 'min':
      return acc.min;
    case 'max':
      return acc.max;
    default: {
      const sorted = [...(acc.values ?? [])].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }
}

function isSkippedKey(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === '';
}

export interface GroupByResult {
  groups: Array<{ key: string; value: number; count: number }>;
  /** True when more than maxGroups distinct keys existed. */
  truncated: boolean;
}

/**
 * Groups rows by a column's formatted value and aggregates. Missing
 * group keys are skipped; value aggregates read only numeric cells of
 * `valueColumnId`. Groups are sorted by value descending and capped.
 * Empty non-count buckets keep their historical value of 0.
 */
export function groupByAgg(
  rows: Record<string, unknown>[],
  groupColumnId: string,
  agg: AggFn,
  valueColumnId?: string,
  maxGroups = 30,
): GroupByResult {
  const buckets = new Map<string, Acc>();
  const collectValues = agg === 'median';
  for (const row of rows) {
    const rawKey = row[groupColumnId];
    if (isSkippedKey(rawKey)) continue;
    const key = formatCell(rawKey);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = newAcc(collectValues);
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (valueColumnId) {
      const value = row[valueColumnId];
      if (typeof value === 'number') pushAcc(bucket, value);
    }
  }

  const groups = [...buckets.entries()].map(([key, bucket]) => ({
    key,
    count: bucket.count,
    value: finishAcc(bucket, agg) ?? 0,
  }));
  groups.sort((a, b) => b.value - a.value);
  return {
    groups: groups.slice(0, maxGroups),
    truncated: groups.length > maxGroups,
  };
}

export interface HistogramBin {
  x0: number;
  x1: number;
  count: number;
}

/** Equal-width bins over the numeric values of a column. */
export function histogram(
  rows: Record<string, unknown>[],
  columnId: string,
  binCount = 20,
): HistogramBin[] {
  const values: number[] = [];
  for (const row of rows) {
    const value = row[columnId];
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.push(value);
    }
  }
  if (values.length === 0) return [];
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return [{ x0: min, x1: max, count: values.length }];

  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    x0: min + i * width,
    x1: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    const index = Math.min(Math.floor((v - min) / width), binCount - 1);
    bins[index].count += 1;
  }
  return bins;
}

export interface DateSeriesPoint {
  date: string;
  value: number;
}

/**
 * Aggregates per exact formatted date, sorted chronologically (ISO
 * lexicographic), stride-downsampled to maxPoints.
 */
export function dateSeries(
  rows: Record<string, unknown>[],
  dateColumnId: string,
  agg: AggFn,
  valueColumnId?: string,
  maxPoints = 500,
): DateSeriesPoint[] {
  const result = groupByAgg(
    rows,
    dateColumnId,
    agg,
    valueColumnId,
    Number.MAX_SAFE_INTEGER,
  );
  const points = result.groups
    .map((g) => ({ date: g.key, value: g.value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (points.length <= maxPoints) return points;
  const stride = points.length / maxPoints;
  return Array.from(
    { length: maxPoints },
    (_, i) => points[Math.floor(i * stride)],
  );
}

export interface ScatterPoint {
  x: number;
  y: number;
}

export interface ScatterResult {
  points: ScatterPoint[];
  /** True when more than maxPoints pairs existed (deterministic sample). */
  truncated: boolean;
}

/** Raw x/y pairs where both cells are finite numbers; stride-sampled. */
export function scatterPoints(
  rows: Record<string, unknown>[],
  xColumnId: string,
  yColumnId: string,
  maxPoints = 1000,
): ScatterResult {
  const points: ScatterPoint[] = [];
  for (const row of rows) {
    const x = row[xColumnId];
    const y = row[yColumnId];
    if (
      typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y)
    ) {
      points.push({ x, y });
    }
  }
  if (points.length <= maxPoints) return { points, truncated: false };
  const stride = points.length / maxPoints;
  return {
    points: Array.from(
      { length: maxPoints },
      (_, i) => points[Math.floor(i * stride)],
    ),
    truncated: true,
  };
}

export interface GroupBySplitResult {
  /** values[] aligned with seriesKeys; null = no data for that cell. */
  groups: Array<{ key: string; count: number; values: Array<number | null> }>;
  seriesKeys: string[];
  truncatedGroups: boolean;
  truncatedSeries: boolean;
}

/**
 * Two-dimensional group-by: one bucket per (group, series) cell. Series
 * are the top `maxSeries` split values by row count — deliberately no
 * "other" series, which would corrupt mean/min/max/median. Cells with
 * no data are null (bar skipped / line gap), never a fake zero. Groups
 * sort by total row count descending; ties break by key.
 */
export function groupBySplit(
  rows: Record<string, unknown>[],
  groupColumnId: string,
  splitColumnId: string,
  agg: AggFn,
  valueColumnId?: string,
  maxGroups = 12,
  maxSeries = 6,
): GroupBySplitResult {
  const collectValues = agg === 'median';
  const seriesTotals = new Map<string, number>();
  const groupData = new Map<
    string,
    { count: number; cells: Map<string, Acc> }
  >();
  for (const row of rows) {
    const rawGroup = row[groupColumnId];
    const rawSplit = row[splitColumnId];
    if (isSkippedKey(rawGroup) || isSkippedKey(rawSplit)) continue;
    const groupKey = formatCell(rawGroup);
    const splitKey = formatCell(rawSplit);
    seriesTotals.set(splitKey, (seriesTotals.get(splitKey) ?? 0) + 1);
    let group = groupData.get(groupKey);
    if (!group) {
      group = { count: 0, cells: new Map() };
      groupData.set(groupKey, group);
    }
    group.count += 1;
    let cell = group.cells.get(splitKey);
    if (!cell) {
      cell = newAcc(collectValues);
      group.cells.set(splitKey, cell);
    }
    cell.count += 1;
    if (valueColumnId) {
      const value = row[valueColumnId];
      if (typeof value === 'number') pushAcc(cell, value);
    }
  }

  const byCountThenKey = (
    a: [string, { count: number }],
    b: [string, { count: number }],
  ) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const seriesKeys = [...seriesTotals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxSeries)
    .map(([key]) => key);
  const sortedGroups = [...groupData.entries()].sort(byCountThenKey);
  const groups = sortedGroups.slice(0, maxGroups).map(([key, group]) => ({
    key,
    count: group.count,
    values: seriesKeys.map((series) => {
      const cell = group.cells.get(series);
      return cell ? finishAcc(cell, agg) : null;
    }),
  }));
  return {
    groups,
    seriesKeys,
    truncatedGroups: sortedGroups.length > maxGroups,
    truncatedSeries: seriesTotals.size > maxSeries,
  };
}

export interface DateSeriesSplitResult {
  /** Chronological; values[] aligned with seriesKeys, null = gap. */
  points: Array<{ date: string; values: Array<number | null> }>;
  seriesKeys: string[];
  truncatedSeries: boolean;
}

/** Multi-series counterpart of dateSeries, via groupBySplit. */
export function dateSeriesSplit(
  rows: Record<string, unknown>[],
  dateColumnId: string,
  splitColumnId: string,
  agg: AggFn,
  valueColumnId?: string,
  maxPoints = 300,
  maxSeries = 6,
): DateSeriesSplitResult {
  const result = groupBySplit(
    rows,
    dateColumnId,
    splitColumnId,
    agg,
    valueColumnId,
    Number.MAX_SAFE_INTEGER,
    maxSeries,
  );
  const points = result.groups
    .map((group) => ({ date: group.key, values: group.values }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sampled =
    points.length <= maxPoints
      ? points
      : Array.from(
          { length: maxPoints },
          (_, i) => points[Math.floor(i * (points.length / maxPoints))],
        );
  return {
    points: sampled,
    seriesKeys: result.seriesKeys,
    truncatedSeries: result.truncatedSeries,
  };
}

export interface PivotResult {
  /** values[] aligned with valueColumnIds; null = no numeric cells. */
  rows: Array<{ key: string; count: number; values: Array<number | null> }>;
  truncated: boolean;
}

/**
 * Group-by summary table: one aggregate per (group, value column).
 * With agg 'count' (or no value columns) rows carry empty values and
 * the table is key + count only. Sorted by count descending, ties by
 * key; capped at maxGroups (the table scrolls, so the cap is generous).
 */
export function pivotTable(
  rows: Record<string, unknown>[],
  groupColumnId: string,
  agg: AggFn,
  valueColumnIds: string[],
  maxGroups = 100,
): PivotResult {
  const ids = agg === 'count' ? [] : valueColumnIds;
  const collectValues = agg === 'median';
  const buckets = new Map<string, { count: number; accs: Acc[] }>();
  for (const row of rows) {
    const rawKey = row[groupColumnId];
    if (isSkippedKey(rawKey)) continue;
    const key = formatCell(rawKey);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, accs: ids.map(() => newAcc(collectValues)) };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    ids.forEach((id, i) => {
      const value = row[id];
      if (typeof value === 'number') pushAcc(bucket!.accs[i], value);
    });
  }

  const sorted = [...buckets.entries()].sort(
    (a, b) =>
      b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return {
    rows: sorted.slice(0, maxGroups).map(([key, bucket]) => ({
      key,
      count: bucket.count,
      values: bucket.accs.map((acc) => finishAcc(acc, agg)),
    })),
    truncated: sorted.length > maxGroups,
  };
}
