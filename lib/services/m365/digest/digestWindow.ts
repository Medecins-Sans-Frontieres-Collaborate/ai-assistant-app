/**
 * Digest period presets → concrete windows (docs/M365_DAILY_DIGEST.md §2).
 * Pure and shared: the CLIENT resolves presets in the user's local time
 * zone and sends ISO instants; the server only validates them.
 */
export type DigestPeriodPreset =
  | 'lastWorkday'
  | '1d'
  | '3d'
  | '7d'
  | '14d'
  | 'custom';

export const DIGEST_PRESETS: readonly DigestPeriodPreset[] = [
  'lastWorkday',
  '1d',
  '3d',
  '7d',
  '14d',
  'custom',
] as const;

export const DIGEST_DEFAULT_PRESET: DigestPeriodPreset = '7d';

/** Hard ceiling on any window: a month is already far past what the caps can cover. */
export const DIGEST_MAX_WINDOW_DAYS = 31;
/**
 * The longest span accepted, in ms: the day count as calendar days
 * (local 00:00 → 23:59:59 is N days + 1) plus a DST hour. Shared by the
 * launcher's validation and the route so both agree.
 */
export const DIGEST_MAX_WINDOW_MS =
  (DIGEST_MAX_WINDOW_DAYS + 1) * 86_400_000 + 3_600_000;

const DAY_MS = 86_400_000;

export function isDigestPreset(value: unknown): value is DigestPeriodPreset {
  return DIGEST_PRESETS.includes(value as DigestPeriodPreset);
}

/**
 * Local midnight of the most recent WORKDAY strictly before `now`, so the
 * window always contains at least one full weekday plus any weekend in
 * between: Monday → Friday 00:00 (Fri + Sat + Sun + Monday so far);
 * Tuesday → Monday 00:00; Saturday or Sunday → Friday 00:00. Public
 * holidays are not known here and are not skipped.
 */
export function lastWorkdayStart(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  do {
    start.setDate(start.getDate() - 1);
  } while (start.getDay() === 0 || start.getDay() === 6);
  return start;
}

export interface ResolvedDigestWindow {
  startIso: string;
  endIso: string;
  preset: DigestPeriodPreset;
}

/**
 * Resolves a preset at `now` (local time for `lastWorkday`). `custom` needs
 * both bounds; they are clamped to DIGEST_MAX_WINDOW_DAYS and must be
 * ordered.
 */
export function resolveDigestWindow(
  preset: DigestPeriodPreset,
  now: Date = new Date(),
  custom?: { startIso: string; endIso: string },
): ResolvedDigestWindow {
  if (preset === 'custom') {
    if (!custom) throw new RangeError('custom window needs start and end');
    const start = Date.parse(custom.startIso);
    const end = Date.parse(custom.endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new RangeError('custom window must be an ordered ISO range');
    }
    if (end - start > DIGEST_MAX_WINDOW_MS) {
      throw new RangeError(
        `custom window may span at most ${DIGEST_MAX_WINDOW_DAYS} days`,
      );
    }
    return {
      startIso: new Date(start).toISOString(),
      endIso: new Date(end).toISOString(),
      preset,
    };
  }
  const endIso = now.toISOString();
  if (preset === 'lastWorkday') {
    return { startIso: lastWorkdayStart(now).toISOString(), endIso, preset };
  }
  const days = Number(preset.slice(0, -1));
  return {
    startIso: new Date(now.getTime() - days * DAY_MS).toISOString(),
    endIso,
    preset,
  };
}

/** Server-side validation of a client-resolved window. */
export function validateDigestWindow(window: {
  startIso?: unknown;
  endIso?: unknown;
  preset?: unknown;
}): ResolvedDigestWindow {
  if (!isDigestPreset(window.preset)) {
    throw new RangeError('unknown digest period preset');
  }
  if (
    typeof window.startIso !== 'string' ||
    typeof window.endIso !== 'string'
  ) {
    throw new RangeError('window bounds must be ISO strings');
  }
  const start = Date.parse(window.startIso);
  const end = Date.parse(window.endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new RangeError('window must be an ordered ISO range');
  }
  if (end - start > DIGEST_MAX_WINDOW_MS) {
    throw new RangeError(
      `window may span at most ${DIGEST_MAX_WINDOW_DAYS} days`,
    );
  }
  // A window ending in the future is just "until now"; one that STARTS in
  // the future has nothing to scan and would invert after the cap.
  const cappedEnd = Math.min(end, Date.now() + 60_000);
  if (start >= cappedEnd) {
    throw new RangeError('window must start in the past');
  }
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(cappedEnd).toISOString(),
    preset: window.preset,
  };
}

/** Whole days covered, at least 1 — for "last N days" labels. */
export function digestWindowDays(window: {
  startIso: string;
  endIso: string;
}): number {
  const span = Date.parse(window.endIso) - Date.parse(window.startIso);
  return Math.max(1, Math.round(span / DAY_MS));
}
