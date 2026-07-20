import {
  advanceByPrecision,
  coarserPrecision,
  eventRangeEndsAt,
  eventRangeExtent,
  eventRangeFromLegacy,
  formatEventInstant,
  formatEventInstantLabel,
  normalizeEventRange,
  parseEventInstant,
} from '@/lib/utils/shared/date/eventRange';

import { EventRange } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const range = (over: Partial<EventRange> = {}): EventRange => ({
  start: '2026-03-12T00:00',
  end: null,
  precision: 'day',
  ...over,
});

describe('parseEventInstant', () => {
  it('parses minute-resolution UTC instants', () => {
    expect(parseEventInstant('2026-03-12T14:30')).toBe(
      Date.UTC(2026, 2, 12, 14, 30),
    );
  });

  it('rejects anything malformed rather than guessing', () => {
    for (const bad of [
      '',
      '2026',
      '2026-03-12',
      '2026-03-12T14',
      '2026-13-01T00:00',
      '2026-02-30T00:00',
      '2026-03-12T24:00',
      '2026-03-12T00:60',
      '0900-01-01T00:00',
      'soon',
      undefined,
    ]) {
      expect(parseEventInstant(bad)).toBeNull();
    }
  });

  it('round-trips through the formatter', () => {
    const ms = Date.UTC(2026, 2, 12, 14, 30);
    expect(parseEventInstant(formatEventInstant(ms))).toBe(ms);
  });
});

describe('advanceByPrecision', () => {
  it('is calendar-aware for months and years', () => {
    const jan31 = Date.UTC(2026, 0, 31);
    expect(advanceByPrecision(jan31, 'month')).toBe(Date.UTC(2026, 1, 31));
    expect(advanceByPrecision(jan31, 'year')).toBe(Date.UTC(2027, 0, 31));
    // Leap day is reachable: 2028 is a leap year.
    expect(advanceByPrecision(Date.UTC(2028, 1, 29), 'day')).toBe(
      Date.UTC(2028, 2, 1),
    );
  });

  it('is exact for fixed-width units', () => {
    const ms = Date.UTC(2026, 2, 12, 14, 30);
    expect(advanceByPrecision(ms, 'minute')).toBe(ms + 60_000);
    expect(advanceByPrecision(ms, 'hour')).toBe(ms + 3_600_000);
  });
});

describe('eventRangeExtent', () => {
  it('covers one unit of its own precision when no end is stated', () => {
    expect(eventRangeExtent(range({ precision: 'year' }))).toEqual({
      startMs: Date.UTC(2026, 2, 12),
      endMs: Date.UTC(2027, 2, 12),
    });
    expect(eventRangeExtent(range({ precision: 'minute' }))).toEqual({
      startMs: Date.UTC(2026, 2, 12),
      endMs: Date.UTC(2026, 2, 12, 0, 1),
    });
  });

  it('uses the stated end when there is one', () => {
    expect(eventRangeExtent(range({ end: '2026-03-20T00:00' }))).toEqual({
      startMs: Date.UTC(2026, 2, 12),
      endMs: Date.UTC(2026, 2, 20),
    });
  });

  it('extends an ongoing event to now', () => {
    const now = Date.UTC(2026, 5, 10);
    expect(eventRangeExtent(range({ ongoing: true }), now)?.endMs).toBe(now);
  });

  it('returns null for an unparseable start', () => {
    expect(eventRangeExtent(range({ start: 'nonsense' }))).toBeNull();
  });
});

describe('eventRangeEndsAt', () => {
  it('only a stated end concludes an event', () => {
    expect(eventRangeEndsAt(range())).toBeNull();
    expect(eventRangeEndsAt(range({ ongoing: true }))).toBeNull();
    expect(eventRangeEndsAt(range({ end: '2026-03-20T00:00' }))).toBe(
      Date.UTC(2026, 2, 20),
    );
  });

  it('ignores a stated end while ongoing is set', () => {
    expect(
      eventRangeEndsAt(range({ end: '2026-03-20T00:00', ongoing: true })),
    ).toBeNull();
  });
});

describe('normalizeEventRange', () => {
  it('drops junk to undated rather than corrupting the timeline', () => {
    expect(normalizeEventRange(undefined)).toBeNull();
    expect(normalizeEventRange({ start: '' })).toBeNull();
    expect(normalizeEventRange({ start: 'last Tuesday' })).toBeNull();
  });

  it('swaps a transposed range instead of discarding an instant', () => {
    expect(
      normalizeEventRange({
        start: '2026-06-01T00:00',
        end: '2026-02-01T00:00',
        precision: 'month',
      }),
    ).toEqual({
      start: '2026-02-01T00:00',
      end: '2026-06-01T00:00',
      precision: 'month',
    });
  });

  it('lets a stated end outrank the ongoing flag', () => {
    const result = normalizeEventRange({
      start: '2026-01-01T00:00',
      end: '2026-03-01T00:00',
      precision: 'month',
      ongoing: true,
    });
    expect(result?.ongoing).toBeUndefined();
  });

  it('keeps ongoing when no end was stated', () => {
    expect(
      normalizeEventRange({
        start: '2026-01-01T00:00',
        end: '',
        precision: 'month',
        ongoing: true,
      })?.ongoing,
    ).toBe(true);
  });

  it('falls back to day precision when the model omits it', () => {
    expect(normalizeEventRange({ start: '2026-01-01T00:00' })?.precision).toBe(
      'day',
    );
    expect(
      normalizeEventRange({ start: '2026-01-01T00:00', precision: 'century' })
        ?.precision,
    ).toBe('day');
  });
});

describe('eventRangeFromLegacy', () => {
  it('reads a bare year as the whole year', () => {
    expect(eventRangeFromLegacy({ eventStart: '1812' })).toEqual({
      start: '1812-01-01T00:00',
      end: null,
      precision: 'year',
    });
  });

  it('converts an inclusive legacy end to an exclusive instant', () => {
    // "ended in March" covered through 31 March; the first uncovered
    // instant is 1 April.
    expect(
      eventRangeFromLegacy({ eventStart: '2026-01', eventEnd: '2026-03' }),
    ).toEqual({
      start: '2026-01-01T00:00',
      end: '2026-04-01T00:00',
      precision: 'month',
    });
  });

  it('takes the coarser precision so display never overstates', () => {
    expect(
      eventRangeFromLegacy({ eventStart: '2026', eventEnd: '2026-03-15' })
        ?.precision,
    ).toBe('year');
  });

  it('carries the ongoing flag when no end was stated', () => {
    expect(
      eventRangeFromLegacy({ eventStart: '2026-03', eventOngoing: true }),
    ).toEqual({
      start: '2026-03-01T00:00',
      end: null,
      precision: 'month',
      ongoing: true,
    });
  });

  it('reads an end-only legacy feature as the window it named', () => {
    // The old verdict left these visible from the dawn of time, which was
    // an artifact of its check order rather than a claim.
    expect(eventRangeFromLegacy({ eventEnd: '2026-03' })).toEqual({
      start: '2026-03-01T00:00',
      end: '2026-04-01T00:00',
      precision: 'month',
    });
  });

  it('is undated when nothing parses', () => {
    expect(eventRangeFromLegacy({})).toBeNull();
    expect(eventRangeFromLegacy({ eventStart: 'soon' })).toBeNull();
  });
});

describe('formatEventInstantLabel', () => {
  const ms = Date.UTC(2026, 2, 12, 14, 30);

  it('never shows more detail than the precision claims', () => {
    expect(formatEventInstantLabel(ms, 'year', 'en')).toBe('2026');
    expect(formatEventInstantLabel(ms, 'month', 'en')).toBe('Mar 2026');
    expect(formatEventInstantLabel(ms, 'day', 'en')).toBe('Mar 12, 2026');
    // The clock format follows the locale (en-US renders 12-hour), so the
    // assertion is that a time appears at all — not which convention.
    expect(formatEventInstantLabel(ms, 'day', 'en')).not.toMatch(/\d:\d\d/);
    expect(formatEventInstantLabel(ms, 'minute', 'en')).toMatch(/\d:30/);
    expect(formatEventInstantLabel(ms, 'minute', 'en-GB')).toContain('14:30');
  });

  it('degrades to a trimmed ISO shape for an unknown locale', () => {
    expect(formatEventInstantLabel(ms, 'year', 'not-a-locale!')).toBe('2026');
    expect(formatEventInstantLabel(ms, 'month', 'not-a-locale!')).toBe(
      '2026-03',
    );
  });
});

describe('coarserPrecision', () => {
  it('ranks year as the coarsest and minute as the finest', () => {
    expect(coarserPrecision('minute', 'year')).toBe('year');
    expect(coarserPrecision('day', 'hour')).toBe('day');
    expect(coarserPrecision('month', 'month')).toBe('month');
  });
});
