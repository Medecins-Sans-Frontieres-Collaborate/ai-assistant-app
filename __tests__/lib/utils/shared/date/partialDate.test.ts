import {
  parsePartialDate,
  partialDateEndMs,
  partialDateStartMs,
} from '@/lib/utils/shared/date/partialDate';

import { describe, expect, it } from 'vitest';

describe('parsePartialDate', () => {
  it('parses each precision from the string shape', () => {
    expect(parsePartialDate('2026')).toEqual({ year: 2026, precision: 'year' });
    expect(parsePartialDate('2026-03')).toEqual({
      year: 2026,
      month: 3,
      precision: 'month',
    });
    expect(parsePartialDate('2026-03-12')).toEqual({
      year: 2026,
      month: 3,
      day: 12,
      precision: 'day',
    });
  });

  it('rejects malformed and impossible values', () => {
    expect(parsePartialDate('')).toBeNull();
    expect(parsePartialDate(undefined)).toBeNull();
    expect(parsePartialDate('garbage')).toBeNull();
    expect(parsePartialDate('26-03-12')).toBeNull();
    expect(parsePartialDate('2026-13')).toBeNull();
    expect(parsePartialDate('2026-00')).toBeNull();
    expect(parsePartialDate('2026-02-30')).toBeNull();
    expect(parsePartialDate('2026-3-1')).toBeNull(); // must be zero-padded
    expect(parsePartialDate('0500')).toBeNull(); // below year clamp
    expect(parsePartialDate('3026')).toBeNull(); // above year clamp
  });

  it('accepts leap days only in leap years', () => {
    expect(parsePartialDate('2024-02-29')).not.toBeNull();
    expect(parsePartialDate('2026-02-29')).toBeNull();
  });
});

describe('precision widening (start/end ms)', () => {
  it('a year spans Jan 1 to Dec 31 UTC', () => {
    const d = parsePartialDate('2026')!;
    expect(partialDateStartMs(d)).toBe(Date.UTC(2026, 0, 1));
    expect(partialDateEndMs(d)).toBe(Date.UTC(2027, 0, 1) - 1);
  });

  it('a month spans its first to last instant', () => {
    const d = parsePartialDate('2026-02')!;
    expect(partialDateStartMs(d)).toBe(Date.UTC(2026, 1, 1));
    expect(partialDateEndMs(d)).toBe(Date.UTC(2026, 2, 1) - 1);
  });

  it('a day spans midnight to 23:59:59.999', () => {
    const d = parsePartialDate('2026-03-12')!;
    expect(partialDateStartMs(d)).toBe(Date.UTC(2026, 2, 12));
    expect(partialDateEndMs(d)).toBe(Date.UTC(2026, 2, 13) - 1);
  });
});
