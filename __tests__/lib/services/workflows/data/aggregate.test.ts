import {
  dateSeries,
  dateSeriesSplit,
  groupByAgg,
  groupBySplit,
  histogram,
  pivotTable,
  scatterPoints,
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

describe('min/max/median aggregations', () => {
  const rows = [
    { g: 'a', v: 10 },
    { g: 'a', v: 2 },
    { g: 'a', v: 7 },
    { g: 'b', v: 5 },
    { g: 'b', v: 'bad' },
    { g: 'c', v: null },
  ];

  it('computes min, max, and median (odd and even counts)', () => {
    const byKey = (agg: 'min' | 'max' | 'median') =>
      new Map(
        groupByAgg(rows, 'g', agg, 'v').groups.map((g) => [g.key, g.value]),
      );
    expect(byKey('min').get('a')).toBe(2);
    expect(byKey('max').get('a')).toBe(10);
    expect(byKey('median').get('a')).toBe(7);
    const even = groupByAgg(
      [
        { g: 'x', v: 1 },
        { g: 'x', v: 2 },
        { g: 'x', v: 3 },
        { g: 'x', v: 4 },
      ],
      'g',
      'median',
      'v',
    );
    expect(even.groups[0].value).toBe(2.5);
  });

  it('keeps the historical 0 for empty non-count buckets', () => {
    const result = groupByAgg(rows, 'g', 'median', 'v');
    expect(result.groups.find((g) => g.key === 'c')?.value).toBe(0);
  });
});

describe('scatterPoints', () => {
  it('keeps only finite numeric pairs', () => {
    const rows = [
      { x: 1, y: 2 },
      { x: 'a', y: 2 },
      { x: 3, y: null },
      { x: NaN, y: 1 },
      { x: 4, y: 5 },
    ];
    expect(scatterPoints(rows, 'x', 'y')).toEqual({
      points: [
        { x: 1, y: 2 },
        { x: 4, y: 5 },
      ],
      truncated: false,
    });
  });

  it('stride-samples above the cap deterministically', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ x: i, y: i }));
    const result = scatterPoints(rows, 'x', 'y', 100);
    expect(result.points).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.points[0]).toEqual({ x: 0, y: 0 });
  });
});

describe('groupBySplit', () => {
  const rows = [
    { g: 'north', s: 'a', v: 1 },
    { g: 'north', s: 'a', v: 3 },
    { g: 'north', s: 'b', v: 10 },
    { g: 'south', s: 'a', v: 5 },
    { g: 'south', s: null, v: 9 },
    { g: null, s: 'a', v: 9 },
  ];

  it('aligns values with top series and leaves null holes', () => {
    const result = groupBySplit(rows, 'g', 's', 'sum', 'v');
    expect(result.seriesKeys).toEqual(['a', 'b']);
    expect(result.groups).toEqual([
      { key: 'north', count: 3, values: [4, 10] },
      { key: 'south', count: 1, values: [5, null] },
    ]);
    expect(result.truncatedGroups).toBe(false);
    expect(result.truncatedSeries).toBe(false);
  });

  it('caps and flags series and groups deterministically', () => {
    const wide = Array.from({ length: 40 }, (_, i) => ({
      g: `g${i % 15}`,
      s: `s${i % 8}`,
      v: i,
    }));
    const result = groupBySplit(wide, 'g', 's', 'count', undefined, 12, 6);
    expect(result.seriesKeys).toHaveLength(6);
    expect(result.groups).toHaveLength(12);
    expect(result.truncatedSeries).toBe(true);
    expect(result.truncatedGroups).toBe(true);
  });
});

describe('dateSeriesSplit', () => {
  it('sorts chronologically and preserves gaps as null', () => {
    const rows = [
      { d: '2026-02-01', s: 'a', v: 5 },
      { d: '2026-01-01', s: 'a', v: 2 },
      { d: '2026-02-01', s: 'b', v: 7 },
    ];
    const result = dateSeriesSplit(rows, 'd', 's', 'sum', 'v');
    expect(result.seriesKeys).toEqual(['a', 'b']);
    expect(result.points).toEqual([
      { date: '2026-01-01', values: [2, null] },
      { date: '2026-02-01', values: [5, 7] },
    ]);
  });
});

describe('pivotTable', () => {
  const rows = [
    { g: 'north', a: 1, b: 10 },
    { g: 'north', a: 3, b: 'bad' },
    { g: 'south', a: 5, b: null },
  ];

  it('aligns aggregates with valueColumnIds, null for empty buckets', () => {
    const result = pivotTable(rows, 'g', 'mean', ['a', 'b']);
    expect(result.rows).toEqual([
      { key: 'north', count: 2, values: [2, 10] },
      { key: 'south', count: 1, values: [5, null] },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('is count-only with agg count or no value columns', () => {
    expect(pivotTable(rows, 'g', 'count', ['a']).rows[0].values).toEqual([]);
    expect(pivotTable(rows, 'g', 'sum', []).rows[0].values).toEqual([]);
  });

  it('caps groups and flags truncation', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ g: `g${i}` }));
    const result = pivotTable(many, 'g', 'count', [], 100);
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
});
