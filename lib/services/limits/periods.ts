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

/**
 * One formatter per zone, built once. `new Intl.DateTimeFormat` costs
 * ~40 µs against ~1 µs per `formatToParts`, and `resetAt` below calls this
 * up to ~100 times per answer — per counter cell per model in the picker
 * probe, which put 200-350 ms of synchronous CPU on every `/api/limits/me`
 * for a metered user before this cache existed. A garbage zone caches the
 * UTC formatter under its own name, so the fallback is paid once too.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 64;

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  const build = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = build(timezone);
  } catch {
    formatter = build('UTC');
  }
  if (formatters.size >= MAX_FORMATTERS) formatters.clear();
  formatters.set(timezone, formatter);
  return formatter;
}

/** Falls back to UTC rather than throwing on an unknown/garbage zone. */
function partsIn(
  timezone: string,
  at: Date,
): { year: string; month: string; day: string } {
  const parts = formatterFor(timezone).formatToParts(at);
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
  // The boundary is a function of the PERIOD, not of `at`: every instant in
  // today's period rolls over at the same moment. Memoized per
  // (kind, zone, period) so the walk below runs once per period per replica
  // rather than once per cell per request.
  const memoKey = `${kind}|${timezone}|${current}`;
  const memoized = resetAtMemo.get(memoKey);
  if (memoized !== undefined) return memoized;
  const computed = walkToBoundary(kind, timezone, at, current);
  if (resetAtMemo.size >= MAX_RESET_MEMO) resetAtMemo.clear();
  resetAtMemo.set(memoKey, computed);
  return computed;
}

const resetAtMemo = new Map<string, string>();
const MAX_RESET_MEMO = 256;

function walkToBoundary(
  kind: PeriodKind,
  timezone: string,
  at: Date,
  current: string,
): string {
  // Coarse hop first (a day at a time), then a 15-minute walk back to the
  // exact boundary. Bounded: at most 32 + 96 iterations.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;
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
      // Inside the 15-minute bucket, find the exact minute: a zone whose
      // offset is not a multiple of 15 minutes, or a caller in the last
      // bucket of the day, otherwise saw a reset up to 14 minutes late.
      // Memoized per period, so the extra ≤15 steps run once per replica.
      let minute = walked;
      for (let j = 0; j < 15; j++) {
        const candidate = minute + MINUTE_MS;
        if (currentPeriod(kind, timezone, new Date(candidate)) !== current) {
          return new Date(candidate).toISOString();
        }
        minute = candidate;
      }
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
