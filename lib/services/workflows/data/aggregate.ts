import { formatCell } from './tableUtils';

/**
 * Deterministic client-side aggregation for the insights panel and the
 * rail digest — the LLM never computes these. Pure, client-safe.
 */

export type AggFn = 'count' | 'sum' | 'mean';

export interface GroupByResult {
  groups: Array<{ key: string; value: number; count: number }>;
  /** True when more than maxGroups distinct keys existed. */
  truncated: boolean;
}

/**
 * Groups rows by a column's formatted value and aggregates. Missing
 * group keys are skipped; sum/mean read only numeric cells of
 * `valueColumnId`. Groups are sorted by value descending and capped.
 */
export function groupByAgg(
  rows: Record<string, unknown>[],
  groupColumnId: string,
  agg: AggFn,
  valueColumnId?: string,
  maxGroups = 30,
): GroupByResult {
  const buckets = new Map<string, { sum: number; n: number; count: number }>();
  for (const row of rows) {
    const rawKey = row[groupColumnId];
    if (rawKey === null || rawKey === undefined || rawKey === '') continue;
    const key = formatCell(rawKey);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sum: 0, n: 0, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (valueColumnId) {
      const value = row[valueColumnId];
      if (typeof value === 'number') {
        bucket.sum += value;
        bucket.n += 1;
      }
    }
  }

  const groups = [...buckets.entries()].map(([key, bucket]) => ({
    key,
    count: bucket.count,
    value:
      agg === 'count'
        ? bucket.count
        : agg === 'sum'
          ? bucket.sum
          : bucket.n > 0
            ? bucket.sum / bucket.n
            : 0,
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
