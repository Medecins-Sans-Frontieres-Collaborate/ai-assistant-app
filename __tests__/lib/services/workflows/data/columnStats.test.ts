import {
  profileColumn,
  profileTable,
} from '@/lib/services/workflows/data/columnStats';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const numberColumn: DataColumn = { id: 'n', name: 'N', type: 'number' };
const textColumn: DataColumn = { id: 't', name: 'T', type: 'text' };
const dateColumn: DataColumn = { id: 'd', name: 'D', type: 'date' };

describe('profileColumn', () => {
  it('counts missing (null/undefined/empty) and distinct values', () => {
    const rows = [
      { t: 'a' },
      { t: 'b' },
      { t: 'a' },
      { t: null },
      { t: '' },
      {},
    ];
    const profile = profileColumn(textColumn, rows);
    expect(profile.total).toBe(6);
    expect(profile.missing).toBe(3);
    expect(profile.distinct).toBe(2);
  });

  it('computes number stats including even/odd median', () => {
    const odd = profileColumn(numberColumn, [{ n: 3 }, { n: 1 }, { n: 10 }]);
    expect(odd.min).toBe(1);
    expect(odd.max).toBe(10);
    expect(odd.median).toBe(3);
    const even = profileColumn(numberColumn, [
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
    ]);
    expect(even.median).toBe(2.5);
    expect(even.mean).toBe(2.5);
  });

  it('tracks the date range via ISO string order', () => {
    const profile = profileColumn(dateColumn, [
      { d: '2026-03-01' },
      { d: '2025-12-31' },
      { d: '2026-01-15' },
    ]);
    expect(profile.minDate).toBe('2025-12-31');
    expect(profile.maxDate).toBe('2026-03-01');
  });

  it('lists ALL distinct values (sorted by count) only for low-cardinality text', () => {
    const low = profileColumn(textColumn, [{ t: 'x' }, { t: 'x' }, { t: 'y' }]);
    expect(low.topValues).toEqual([
      { value: 'x', count: 2 },
      { value: 'y', count: 1 },
    ]);

    const rows = Array.from({ length: 30 }, (_, i) => ({ t: `v${i}` }));
    const high = profileColumn(textColumn, rows);
    expect(high.topValues).toBeUndefined();
  });

  it('handles an all-null column', () => {
    const profile = profileColumn(numberColumn, [{ n: null }, {}]);
    expect(profile.missing).toBe(2);
    expect(profile.distinct).toBe(0);
    expect(profile.min).toBeUndefined();
    expect(profile.topValues).toBeUndefined();
  });
});

describe('profileTable', () => {
  it('keys profiles by column id', () => {
    const profiles = profileTable(
      [numberColumn, textColumn],
      [{ n: 1, t: 'a' }],
    );
    expect(profiles.get('n')?.distinct).toBe(1);
    expect(profiles.get('t')?.distinct).toBe(1);
  });
});
