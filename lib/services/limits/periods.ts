/**
 * Period boundaries for windowed limits.
 *
 * Resolved with `Intl.DateTimeFormat` against a single org-wide IANA zone
 * from the policy, so every replica computes the same period key for the
 * same instant without a new dependency and without each server's local
 * timezone leaking in. Defaults to UTC.
 *
 * Pure: no node builtins, no storage.
 */
import { PeriodKind } from '@/lib/services/limits/types';

/** Falls back to UTC rather than throwing on an unknown/garbage zone. */
function partsIn(
  timezone: string,
  at: Date,
): { year: string; month: string; day: string } {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timezone);
  } catch {
    parts = format('UTC');
  }
  const pick = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '0000';
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/**
 * The stable key a usage document is stored under:
 * `2026-07-24` (day), `2026-07` (month), `all` (total).
 */
export function currentPeriod(
  kind: PeriodKind,
  timezone = 'UTC',
  at: Date = new Date(),
): string {
  if (kind === 'total') return 'all';
  const { year, month, day } = partsIn(timezone, at);
  return kind === 'month' ? `${year}-${month}` : `${year}-${month}-${day}`;
}

/**
 * When the current period rolls over, as an ISO instant — shown to the user
 * as "resets at" when a limit blocks them, so the message is actionable
 * rather than just a refusal.
 *
 * Computed by walking forward to the first instant whose period key differs,
 * which sidesteps DST arithmetic entirely: a day is not always 24h, and a
 * naive `+86400000` silently produces the wrong boundary twice a year.
 */
export function resetAt(
  kind: PeriodKind,
  timezone = 'UTC',
  at: Date = new Date(),
): string | undefined {
  if (kind === 'total') return undefined;
  const current = currentPeriod(kind, timezone, at);
  // Coarse hop first (a day at a time), then a 15-minute walk back to the
  // exact boundary. Bounded: at most 32 + 96 iterations.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const maxDays = kind === 'month' ? 32 : 2;

  let coarse = at.getTime();
  for (let i = 0; i < maxDays; i++) {
    coarse += DAY_MS;
    if (currentPeriod(kind, timezone, new Date(coarse)) !== current) break;
  }
  let walked = coarse - DAY_MS;
  for (let i = 0; i < 96; i++) {
    const next = walked + QUARTER_HOUR_MS;
    if (currentPeriod(kind, timezone, new Date(next)) !== current) {
      return new Date(next).toISOString();
    }
    walked = next;
  }
  return new Date(coarse).toISOString();
}

/** Windows that consume a counter, mapped to the ledger they live in. */
export function periodKindForWindow(
  window: 'day' | 'month' | 'request' | 'none',
): PeriodKind | null {
  if (window === 'day') return 'day';
  if (window === 'month') return 'month';
  return null;
}
