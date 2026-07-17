import {
  dateSeries,
  groupByAgg,
  histogram,
} from '@/lib/services/workflows/data/aggregate';

import { describe, expect, it } from 'vitest';

describe('groupByAgg', () => {
  const rows = [
    { region: 'North', cases: 10 },
    { region: 'South', cases: 5 },
    { region: 'North', cases: 20 },
    { region: null, cases: 99 },
    { region: 'South', cases: 'bad' },
  ];

  it('counts, sums, and means per formatted group key, skipping missing keys', () => {
    const count = groupByAgg(rows, 'region', 'count');
    expect(count.groups).toEqual([
      { key: 'North', value: 2, count: 2 },
      { key: 'South', value: 2, count: 2 },
    ]);

    const sum = groupByAgg(rows, 'region', 'sum', 'cases');
    expect(sum.groups[0]).toEqual({ key: 'North', value: 30, count: 2 });
    // Non-numeric cells don't poison the aggregate.
    expect(sum.groups[1]).toEqual({ key: 'South', value: 5, count: 2 });

    const mean = groupByAgg(rows, 'region', 'mean', 'cases');
    expect(mean.groups[0].value).toBe(15);
  });

  it('caps groups and reports truncation', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ g: `k${i}` }));
    const result = groupByAgg(many, 'g', 'count', undefined, 30);
    expect(result.groups).toHaveLength(30);
    expect(result.truncated).toBe(true);
  });
});

describe('histogram', () => {
  it('bins values with the max landing in the last bin', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ n: i }));
    const bins = histogram(rows, 'n', 10);
    expect(bins).toHaveLength(10);
    expect(bins[0].count).toBe(10);
    expect(bins[9].count).toBe(10);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(100);
  });

  it('handles constant and empty columns', () => {
    expect(histogram([{ n: 5 }, { n: 5 }], 'n')).toEqual([
      { x0: 5, x1: 5, count: 2 },
    ]);
    expect(histogram([{ n: 'x' }], 'n')).toEqual([]);
  });
});

describe('dateSeries', () => {
  it('aggregates per date in chronological order', () => {
    const rows = [
      { d: '2026-02-01', v: 5 },
      { d: '2026-01-01', v: 2 },
      { d: '2026-02-01', v: 3 },
    ];
    expect(dateSeries(rows, 'd', 'sum', 'v')).toEqual([
      { date: '2026-01-01', value: 2 },
      { date: '2026-02-01', value: 8 },
    ]);
  });

  it('downsamples long series deterministically', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      d: `2026-01-01T${String(i).padStart(4, '0')}`,
    }));
    const points = dateSeries(rows, 'd', 'count', undefined, 100);
    expect(points).toHaveLength(100);
    expect(points[0].date).toBe('2026-01-01T0000');
  });
});
