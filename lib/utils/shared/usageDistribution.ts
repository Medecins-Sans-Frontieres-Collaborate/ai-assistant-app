/**
 * Small, pure statistics over "requests per person per day" samples. Shared
 * by the server (which stores histograms and quantiles in the model day
 * documents) and the limits admin views (which draw them), so both describe
 * a distribution the same way. See docs/MODELS_PAGE_ANALYTICS_DATA.md §5.
 */

/**
 * Inclusive upper bounds of the histogram buckets for requests per person
 * per day; the last bucket is everything above the last edge. Fine at the low
 * end, where most people sit and where caps are set.
 *
 * ⚠ Stored histograms are positional: changing these edges changes what
 * every stored bucket means, so it needs a version bump of the documents
 * that hold them (modelUsageInsights.ts MODEL_DAY_VERSION).
 */
export const REQUEST_BUCKET_EDGES: readonly number[] = [
  1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000,
];

/** The quantiles the admin views read, as fractions. */
export const QUANTILES = {
  p50: 0.5,
  p75: 0.75,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
} as const;
export type QuantileKey = keyof typeof QUANTILES;
export type QuantileSet = Record<QuantileKey, number>;

/** A copy of `values`, ascending. */
export function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * The `q` quantile by the nearest-rank method: the smallest sample such that
 * at least `q` of the samples are at or below it. Always an observed value
 * (never interpolated), which is what "the median person made 4 requests"
 * should mean.
 *
 * @param sortedAscending - The samples, ascending.
 * @param q - A fraction in (0, 1].
 * @returns The quantile, or 0 for an empty sample.
 */
export function quantile(
  sortedAscending: readonly number[],
  q: number,
): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(Math.min(1, Math.max(0, q)) * sortedAscending.length);
  return sortedAscending[Math.max(0, rank - 1)];
}

/** Every quantile in {@link QUANTILES} for one ascending sample. */
export function quantilesOf(sortedAscending: readonly number[]): QuantileSet {
  return {
    p50: quantile(sortedAscending, QUANTILES.p50),
    p75: quantile(sortedAscending, QUANTILES.p75),
    p90: quantile(sortedAscending, QUANTILES.p90),
    p95: quantile(sortedAscending, QUANTILES.p95),
    p99: quantile(sortedAscending, QUANTILES.p99),
  };
}

/** Index of the bucket a value falls in (the last index is "above every edge"). */
export function bucketIndex(
  value: number,
  edges: readonly number[] = REQUEST_BUCKET_EDGES,
): number {
  const index = edges.findIndex((edge) => value <= edge);
  return index < 0 ? edges.length : index;
}

/**
 * Counts per bucket: `edges.length + 1` numbers. Values of 0 or less are not
 * counted; a person who made no request is not part of the distribution.
 */
export function histogramOf(
  values: readonly number[],
  edges: readonly number[] = REQUEST_BUCKET_EDGES,
): number[] {
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const value of values) {
    if (value > 0) counts[bucketIndex(value, edges)] += 1;
  }
  return counts;
}

/**
 * How many samples are at or above `threshold`: with each person's busiest
 * day as the samples, the people a cap of `threshold` would have stopped at
 * least once.
 *
 * @param sortedAscending - The samples, ascending.
 * @param threshold - The cap being tried. 0 or less stops everyone.
 */
export function countAtOrAbove(
  sortedAscending: readonly number[],
  threshold: number,
): number {
  let low = 0;
  let high = sortedAscending.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedAscending[middle] < threshold) low = middle + 1;
    else high = middle;
  }
  return sortedAscending.length - low;
}

/** The sum of a sample. */
export function sumOf(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
