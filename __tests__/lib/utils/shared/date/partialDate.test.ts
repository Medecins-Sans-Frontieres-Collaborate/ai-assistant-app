import {
  comparePartialDates,
  formatPartialDate,
  normalizeEventFields,
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

  it('compares by first covered instant', () => {
    const year = parsePartialDate('2026')!;
    const march = parsePartialDate('2026-03')!;
    expect(comparePartialDates(year, march)).toBeLessThan(0);
  });
});

describe('formatPartialDate', () => {
  const day = parsePartialDate('2026-03-12')!;
  const month = parsePartialDate('2026-03')!;
  const year = parsePartialDate('2026')!;

  it('formats per precision in English', () => {
    expect(formatPartialDate(day, 'en')).toMatch(/Mar/);
    expect(formatPartialDate(day, 'en')).toMatch(/12/);
    expect(formatPartialDate(month, 'en')).toMatch(/Mar/);
    expect(formatPartialDate(month, 'en')).not.toMatch(/12/);
    expect(formatPartialDate(year, 'en')).toBe('2026');
  });

  it('localizes month names', () => {
    expect(formatPartialDate(month, 'fr')).toMatch(/mars/i);
  });

  it('renders non-Latin locales without error', () => {
    expect(formatPartialDate(day, 'ar')).toBeTruthy();
    expect(formatPartialDate(day, 'ja')).toContain('2026');
  });
});

describe('normalizeEventFields', () => {
  it('blanks unparseable values', () => {
    expect(
      normalizeEventFields({ eventStart: 'soon', eventEnd: '2026-02-30' }),
    ).toEqual({ eventStart: '', eventEnd: '', eventOngoing: false });
  });

  it('swaps a transposed range', () => {
    expect(
      normalizeEventFields({ eventStart: '2026-06', eventEnd: '2026-02' }),
    ).toEqual({
      eventStart: '2026-02',
      eventEnd: '2026-06',
      eventOngoing: false,
    });
  });

  it('does not swap overlapping precisions', () => {
    // "2026" start with "2026-03" end: end falls inside the start year — valid.
    expect(
      normalizeEventFields({ eventStart: '2026', eventEnd: '2026-03' }),
    ).toEqual({ eventStart: '2026', eventEnd: '2026-03', eventOngoing: false });
  });

  it('an explicit end outranks the ongoing flag', () => {
    expect(
      normalizeEventFields({
        eventStart: '2026-01',
        eventEnd: '2026-03',
        eventOngoing: true,
      }).eventOngoing,
    ).toBe(false);
  });

  it('allows ongoing with no start', () => {
    expect(normalizeEventFields({ eventOngoing: true })).toEqual({
      eventStart: '',
      eventEnd: '',
      eventOngoing: true,
    });
  });

  it('allows future dates', () => {
    expect(normalizeEventFields({ eventStart: '2030-01' }).eventStart).toBe(
      '2030-01',
    );
  });
});
