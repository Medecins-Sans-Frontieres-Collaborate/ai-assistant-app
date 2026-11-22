import {
  REQUEST_BUCKET_EDGES,
  ascending,
  bucketIndex,
  countAtOrAbove,
  histogramOf,
  quantile,
  quantilesOf,
  sumOf,
} from '@/lib/utils/shared/usageDistribution';

import { describe, expect, it } from 'vitest';

describe('usageDistribution', () => {
  it('reads quantiles by nearest rank, as observed values', () => {
    const sample = ascending([9, 1, 4, 2, 100, 3, 31, 5, 7, 6]);
    expect(sample).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 31, 100]);
    expect(quantile(sample, 0.5)).toBe(5);
    expect(quantile(sample, 0.75)).toBe(9);
    expect(quantile(sample, 0.9)).toBe(31);
    expect(quantile(sample, 0.95)).toBe(100);
    expect(quantile(sample, 1)).toBe(100);
    expect(quantilesOf(sample)).toEqual({
      p50: 5,
      p75: 9,
      p90: 31,
      p95: 100,
      p99: 100,
    });
  });

  it('answers 0 for an empty sample and the value itself for one', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([7], 0.01)).toBe(7);
    expect(quantile([7], 0.99)).toBe(7);
  });

  it('puts a value exactly on an edge in that bucket, and one over in the next', () => {
    // Edges are inclusive upper bounds: both sides of each boundary.
    expect(bucketIndex(1)).toBe(0);
    expect(bucketIndex(2)).toBe(1);
    expect(bucketIndex(3)).toBe(2);
    expect(bucketIndex(4)).toBe(3);
    expect(bucketIndex(5)).toBe(3);
    expect(bucketIndex(6)).toBe(4);
    const last = REQUEST_BUCKET_EDGES.length - 1;
    expect(bucketIndex(1000)).toBe(last);
    expect(bucketIndex(1001)).toBe(last + 1);
  });

  it('counts people per bucket and leaves out those with no requests', () => {
    const counts = histogramOf([0, 1, 1, 2, 5, 6, 2000]);
    expect(counts).toHaveLength(REQUEST_BUCKET_EDGES.length + 1);
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBe(1);
    expect(counts[3]).toBe(1);
    expect(counts[4]).toBe(1);
    expect(counts[counts.length - 1]).toBe(1);
    expect(sumOf(counts)).toBe(6);
  });

  it('replays a cap: people at or above it, on both sides of the boundary', () => {
    const peaks = [1, 4, 4, 9, 30, 30, 100];
    expect(countAtOrAbove(peaks, 30)).toBe(3);
    expect(countAtOrAbove(peaks, 31)).toBe(1);
    expect(countAtOrAbove(peaks, 29)).toBe(3);
    expect(countAtOrAbove(peaks, 100)).toBe(1);
    expect(countAtOrAbove(peaks, 101)).toBe(0);
    expect(countAtOrAbove(peaks, 0)).toBe(7);
    expect(countAtOrAbove([], 5)).toBe(0);
  });
});
