import {
  parsePartialDate,
  partialDateEndMs,
  partialDateStartMs,
} from '@/lib/utils/shared/date/partialDate';

import { EventPrecision, EventRange } from '@/types/workflow';

/**
 * Event timing for extracted data.
 *
 * Every event is a RANGE — a half-open interval `[start, end)` at minute
 * resolution — carrying an explicit `precision` describing how finely the
 * material actually stated it. Splitting the two matters: "March 2026" and
 * "1 March 2026 00:00–31 March 2026 24:00" cover the same instants but are
 * very different claims, and the old scheme (precision encoded in the string
 * shape) could not express a time of day at all.
 *
 * `precision` is for DISPLAY and for the implied width of an open-ended
 * event. It never changes interval math — the interval already says exactly
 * what it covers.
 *
 * The predecessor shape (`eventStart`/`eventEnd`/`eventOngoing` partial ISO
 * dates) is still readable via `eventRangeFromLegacy`, so maps built before
 * this model keep working untouched.
 */

/** UTC, minute resolution: 'YYYY-MM-DDTHH:mm'. */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MIN_YEAR = 1000;
const MAX_YEAR = 2100;

const PRECISIONS: EventPrecision[] = ['minute', 'hour', 'day', 'month', 'year'];
/** Ascending coarseness, so `Math.max` picks the safer (coarser) claim. */
const COARSENESS: Record<EventPrecision, number> = {
  minute: 0,
  hour: 1,
  day: 2,
  month: 3,
  year: 4,
};

export function isEventPrecision(value: unknown): value is EventPrecision {
  return PRECISIONS.includes(value as EventPrecision);
}

/** Strict parse to UTC ms; null for anything malformed or out of range. */
export function parseEventInstant(
  value: string | undefined | null,
): number | null {
  if (!value) return null;
  const match = INSTANT_RE.exec(value.trim());
  if (!match) return null;

  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59) return null;

  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const date = new Date(ms);
  // UTC round-trip rejects impossible dates like 2026-02-30T00:00.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return ms;
}

export function formatEventInstant(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * One unit of `precision` after `ms` — the window an open-ended event
 * implicitly covers. Calendar-aware (months and years are not fixed spans),
 * which is why this takes an instant rather than returning a duration.
 */
export function advanceByPrecision(
  ms: number,
  precision: EventPrecision,
): number {
  const d = new Date(ms);
  switch (precision) {
    case 'minute':
      return ms + 60_000;
    case 'hour':
      return ms + 3_600_000;
    case 'day':
      return ms + 86_400_000;
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    case 'year':
      return Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate());
  }
}

export function coarserPrecision(
  a: EventPrecision,
  b: EventPrecision,
): EventPrecision {
  return COARSENESS[a] >= COARSENESS[b] ? a : b;
}

export interface EventExtent {
  startMs: number;
  /** Exclusive. */
  endMs: number;
}

/**
 * The instants a range covers.
 *
 * An event with no stated end covers one unit of its own precision — a
 * bare "1812" covers 1812, a "14:30" covers that minute. Ongoing events
 * extend to now, so a situation that started in March and hasn't ended
 * still reads as current on the timeline.
 */
export function eventRangeExtent(
  range: EventRange,
  nowMs: number = Date.now(),
): EventExtent | null {
  const startMs = parseEventInstant(range.start);
  if (startMs === null) return null;

  const explicitEnd = parseEventInstant(range.end);
  let endMs =
    explicitEnd !== null
      ? explicitEnd
      : advanceByPrecision(startMs, range.precision);
  if (endMs <= startMs) endMs = advanceByPrecision(startMs, range.precision);
  if (range.ongoing) endMs = Math.max(endMs, nowMs);
  return { startMs, endMs };
}

/**
 * Does the event conclude at a knowable instant?
 *
 * Only an explicitly stated end removes a feature from the map. An event
 * with no stated end persists after it appears — the material reported that
 * it happened, not that it stopped — and an ongoing one persists by
 * definition. This is the rule the whole time-lapse is built on.
 */
export function eventRangeEndsAt(range: EventRange): number | null {
  if (range.ongoing) return null;
  return parseEventInstant(range.end);
}

/**
 * Validate and repair a range from the model or from storage.
 *
 * Returns null (undated) rather than throwing: bad timing data must degrade
 * to "no date" instead of corrupting the timeline.
 */
export function normalizeEventRange(
  raw:
    | {
        start?: string;
        end?: string | null;
        precision?: string;
        ongoing?: boolean;
      }
    | undefined
    | null,
): EventRange | null {
  if (!raw) return null;
  const startMs = parseEventInstant(raw.start);
  if (startMs === null) return null;

  const precision = isEventPrecision(raw.precision) ? raw.precision : 'day';
  let endMs = parseEventInstant(raw.end);
  // A transposed range is the likely model error; swapping preserves both
  // instants, where dropping the end would silently widen the event.
  let start = startMs;
  if (endMs !== null && endMs < startMs) {
    start = endMs;
    endMs = startMs;
  }
  // An explicit end outranks the ongoing flag, as it did in the old shape.
  const ongoing = endMs === null && raw.ongoing === true;

  return {
    start: formatEventInstant(start),
    end: endMs === null ? null : formatEventInstant(endMs),
    precision,
    ...(ongoing ? { ongoing: true } : {}),
  };
}

/**
 * Read the predecessor shape. A partial ISO date already encodes an
 * interval — "2026-03" means the whole of March — so the conversion is
 * exact: the end instant becomes the first instant NOT covered, and the
 * range takes the coarser of the two precisions so display never claims
 * more than the material gave.
 */
export function eventRangeFromLegacy(legacy: {
  eventStart?: string;
  eventEnd?: string;
  eventOngoing?: boolean;
}): EventRange | null {
  const start = parsePartialDate(legacy.eventStart);
  const end = parsePartialDate(legacy.eventEnd);
  if (!start && !end) return null;

  // Legacy ends were INCLUSIVE of their precision window, so the first
  // uncovered instant is one ms later; round up to the minute grid.
  const exclusiveEnd = (d: NonNullable<typeof end>) =>
    formatEventInstant(Math.ceil((partialDateEndMs(d) + 1) / 60_000) * 60_000);

  if (!start && end) {
    // "ended in March" with no stated start. The old verdict left these
    // active from the dawn of time, which was an artifact of the check
    // order rather than a claim the material made; the honest reading is
    // the window the material actually named.
    return {
      start: formatEventInstant(partialDateStartMs(end)),
      end: exclusiveEnd(end),
      precision: end.precision,
    };
  }

  const from = start as NonNullable<typeof start>;
  return {
    start: formatEventInstant(partialDateStartMs(from)),
    end: end ? exclusiveEnd(end) : null,
    // Coarser of the two: a range is displayed at one precision, and
    // overstating either endpoint would invent detail the material lacked.
    precision: end
      ? coarserPrecision(from.precision, end.precision)
      : from.precision,
    ...(legacy.eventOngoing && !end ? { ongoing: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

const INSTANT_FORMAT: Record<EventPrecision, Intl.DateTimeFormatOptions> = {
  year: { year: 'numeric', timeZone: 'UTC' },
  month: { year: 'numeric', month: 'short', timeZone: 'UTC' },
  day: { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
  hour: {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  },
  minute: {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  },
};

/** Precision-aware, locale-aware, UTC-pinned instant label. */
export function formatEventInstantLabel(
  ms: number,
  precision: EventPrecision,
  locale: string,
): string {
  try {
    return new Intl.DateTimeFormat(locale, INSTANT_FORMAT[precision]).format(
      ms,
    );
  } catch {
    // Unknown locale tag: fall back to the raw ISO-ish shape, trimmed to
    // the precision so it still never overstates.
    const iso = formatEventInstant(ms);
    if (precision === 'year') return iso.slice(0, 4);
    if (precision === 'month') return iso.slice(0, 7);
    if (precision === 'day') return iso.slice(0, 10);
    return iso.replace('T', ' ');
  }
}
