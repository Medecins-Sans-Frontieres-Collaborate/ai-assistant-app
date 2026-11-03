import {
  DIGEST_MAX_WINDOW_DAYS,
  digestWindowDays,
  lastWorkdayStart,
  resolveDigestWindow,
  validateDigestWindow,
} from '@/lib/services/m365/digest/digestWindow';

import { describe, expect, it } from 'vitest';

/** Local-time constructor so the weekday maths is timezone-stable. */
const local = (y: number, m: number, d: number, h = 9) =>
  new Date(y, m - 1, d, h, 0, 0);

describe('lastWorkdayStart', () => {
  it.each([
    // 2026-11-02 is a Monday → Friday 30 Oct 00:00 (covers Fri + weekend)
    [local(2026, 11, 2), local(2026, 10, 30, 0)],
    // Tuesday → Monday
    [local(2026, 11, 3), local(2026, 11, 2, 0)],
    // Saturday → Friday
    [local(2026, 10, 31), local(2026, 10, 30, 0)],
    // Sunday → Friday
    [local(2026, 11, 1), local(2026, 10, 30, 0)],
    // Friday → Thursday
    [local(2026, 10, 30), local(2026, 10, 29, 0)],
  ])('%s → %s', (now, expected) => {
    expect(lastWorkdayStart(now).getTime()).toBe(expected.getTime());
  });
});

describe('resolveDigestWindow', () => {
  it('fixed presets end now and span the preset length', () => {
    const now = new Date('2026-11-02T09:00:00Z');
    const window = resolveDigestWindow('7d', now);
    expect(window.endIso).toBe(now.toISOString());
    expect(Date.parse(window.endIso) - Date.parse(window.startIso)).toBe(
      7 * 86_400_000,
    );
  });

  it('lastWorkday on a Monday reaches back to Friday midnight', () => {
    const window = resolveDigestWindow('lastWorkday', local(2026, 11, 2));
    expect(new Date(window.startIso).getTime()).toBe(
      local(2026, 10, 30, 0).getTime(),
    );
  });

  it('custom windows must be ordered and bounded', () => {
    expect(() =>
      resolveDigestWindow('custom', new Date(), {
        startIso: '2026-10-10T00:00:00Z',
        endIso: '2026-10-01T00:00:00Z',
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveDigestWindow('custom', new Date(), {
        startIso: '2026-01-01T00:00:00Z',
        endIso: `2026-0${1 + Math.ceil((DIGEST_MAX_WINDOW_DAYS + 5) / 31)}-15T00:00:00Z`,
      }),
    ).toThrow(RangeError);
  });
});

describe('validateDigestWindow', () => {
  it('rejects malformed input and caps the end at roughly now', () => {
    expect(() => validateDigestWindow({})).toThrow();
    expect(() =>
      validateDigestWindow({ startIso: 'x', endIso: 'y', preset: '7d' }),
    ).toThrow();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const window = validateDigestWindow({
      startIso: new Date(Date.now() - 86_400_000).toISOString(),
      endIso: future,
      preset: '1d',
    });
    expect(Date.parse(window.endIso)).toBeLessThan(Date.parse(future));
  });

  it('rejects a window that starts in the future and accepts a full 31-calendar-day local range', () => {
    const now = Date.now();
    expect(() =>
      validateDigestWindow({
        startIso: new Date(now + 10 * 60_000).toISOString(),
        endIso: new Date(now + 20 * 60_000).toISOString(),
        preset: 'custom',
      }),
    ).toThrow(/start in the past/);
    // 31 calendar days sent as local 00:00 → 23:59:59 is 31 d + 86 399 s.
    const start = now - 31 * 86_400_000 - 86_399_000;
    expect(
      validateDigestWindow({
        startIso: new Date(start).toISOString(),
        endIso: new Date(now).toISOString(),
        preset: 'custom',
      }).preset,
    ).toBe('custom');
    expect(() =>
      validateDigestWindow({
        startIso: new Date(now - 33 * 86_400_000).toISOString(),
        endIso: new Date(now).toISOString(),
        preset: 'custom',
      }),
    ).toThrow(/at most/);
  });

  it('digestWindowDays rounds up to whole days, minimum 1', () => {
    expect(
      digestWindowDays({
        startIso: '2026-10-30T00:00:00Z',
        endIso: '2026-10-30T06:00:00Z',
      }),
    ).toBe(1);
    expect(
      digestWindowDays({
        startIso: '2026-10-23T00:00:00Z',
        endIso: '2026-10-30T00:00:00Z',
      }),
    ).toBe(7);
  });
});
