import { currentPeriod, resetAt } from '@/lib/services/limits/periods';

import { describe, expect, it } from 'vitest';

describe('currentPeriod', () => {
  it('formats day, month and total keys', () => {
    const at = new Date('2026-07-24T15:30:00.000Z');
    expect(currentPeriod('day', 'UTC', at)).toBe('2026-07-24');
    expect(currentPeriod('month', 'UTC', at)).toBe('2026-07');
    expect(currentPeriod('total', 'UTC', at)).toBe('all');
  });

  it('respects the configured timezone at a day boundary', () => {
    // 23:30 in New York is already the next day in UTC.
    const at = new Date('2026-07-25T03:30:00.000Z');
    expect(currentPeriod('day', 'UTC', at)).toBe('2026-07-25');
    expect(currentPeriod('day', 'America/New_York', at)).toBe('2026-07-24');
  });

  it('falls back to UTC on a garbage timezone rather than throwing', () => {
    const at = new Date('2026-07-24T15:30:00.000Z');
    expect(currentPeriod('day', 'Not/AZone', at)).toBe('2026-07-24');
  });
});

describe('resetAt', () => {
  it('returns the next UTC midnight for a daily period', () => {
    const at = new Date('2026-07-24T15:30:00.000Z');
    expect(resetAt('day', 'UTC', at)).toBe('2026-07-25T00:00:00.000Z');
  });

  it('returns the first instant of the next month for a monthly period', () => {
    const at = new Date('2026-07-24T15:30:00.000Z');
    expect(resetAt('month', 'UTC', at)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('lands on the zone-local midnight, not the UTC one', () => {
    const at = new Date('2026-07-24T15:30:00.000Z');
    // Midnight in New York (EDT, UTC-4) is 04:00 UTC.
    expect(resetAt('day', 'America/New_York', at)).toBe(
      '2026-07-25T04:00:00.000Z',
    );
  });

  it('handles a DST spring-forward day without drifting', () => {
    // 2026-03-08 is the US spring-forward date; that local day is only 23h.
    const at = new Date('2026-03-08T12:00:00.000Z');
    const reset = resetAt('day', 'America/New_York', at);
    expect(currentPeriod('day', 'America/New_York', new Date(reset!))).toBe(
      '2026-03-09',
    );
  });

  it('has no reset for a total period', () => {
    expect(resetAt('total', 'UTC', new Date())).toBeUndefined();
  });
});
