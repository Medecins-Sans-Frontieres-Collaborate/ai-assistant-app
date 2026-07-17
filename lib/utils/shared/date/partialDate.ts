/**
 * Variable-precision dates for extracted event data.
 *
 * The model reports dates as strings whose SHAPE encodes precision —
 * "2026", "2026-03", "2026-03-12" — so precision can never contradict the
 * value. Everything downstream (display, timeline math) goes through these
 * helpers; raw strings are never interpreted elsewhere.
 */

export type PartialDatePrecision = 'day' | 'month' | 'year';

export interface PartialDate {
  year: number;
  /** 1-12 */
  month?: number;
  /** 1-31 */
  day?: number;
  precision: PartialDatePrecision;
}

const PARTIAL_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const MIN_YEAR = 1000;
const MAX_YEAR = 2100;

/**
 * Strict parse; returns null for anything malformed (empty strings, wrong
 * shapes, month 13, Feb 30, absurd years) so bad model output degrades to
 * "undated" instead of corrupting timeline math.
 */
export function parsePartialDate(
  value: string | undefined | null,
): PartialDate | null {
  if (!value) return null;
  const match = PARTIAL_DATE_RE.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (match[2] === undefined) return { year, precision: 'year' };

  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (match[3] === undefined) return { year, month, precision: 'month' };

  const day = Number(match[3]);
  // UTC round-trip rejects impossible dates like 2026-02-30.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    day < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, precision: 'day' };
}

/** UTC ms of the first instant the date covers ("2026" → Jan 1 00:00Z). */
export function partialDateStartMs(d: PartialDate): number {
  return Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1);
}

/**
 * UTC ms of the last instant the date covers ("2026" → Dec 31 23:59:59.999Z).
 * This is the precision-widening primitive: coarse dates stay "active" for
 * their whole span on the timeline.
 */
export function partialDateEndMs(d: PartialDate): number {
  switch (d.precision) {
    case 'day':
      return (
        Date.UTC(d.year, (d.month as number) - 1, (d.day as number) + 1) - 1
      );
    case 'month':
      // Day 1 of the next month, minus 1ms.
      return Date.UTC(d.year, d.month as number, 1) - 1;
    case 'year':
      return Date.UTC(d.year + 1, 0, 1) - 1;
  }
}

export function comparePartialDates(a: PartialDate, b: PartialDate): number {
  return partialDateStartMs(a) - partialDateStartMs(b);
}

/** Precision-aware, locale-aware, UTC-pinned (no off-by-one) formatting. */
export function formatPartialDate(d: PartialDate, locale: string): string {
  const options: Intl.DateTimeFormatOptions =
    d.precision === 'day'
      ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
      : d.precision === 'month'
        ? { year: 'numeric', month: 'short', timeZone: 'UTC' }
        : { year: 'numeric', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(
      partialDateStartMs(d),
    );
  } catch {
    // Unknown locale tag: fall back to the raw ISO-ish shape.
    return d.precision === 'year'
      ? String(d.year)
      : d.precision === 'month'
        ? `${d.year}-${String(d.month).padStart(2, '0')}`
        : `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  }
}

export interface EventFields {
  eventStart: string;
  eventEnd: string;
  eventOngoing: boolean;
}

/**
 * Server-side normalization of model-reported event fields:
 * - unparseable values become '' (undated)
 * - end before start → swapped (transposition is the likely model error)
 * - an explicit end outranks the ongoing flag
 * Future dates are allowed — planned events are legitimate.
 */
export function normalizeEventFields(fields: {
  eventStart?: string;
  eventEnd?: string;
  eventOngoing?: boolean;
}): EventFields {
  const start = parsePartialDate(fields.eventStart);
  const end = parsePartialDate(fields.eventEnd);

  let eventStart = start ? (fields.eventStart as string).trim() : '';
  let eventEnd = end ? (fields.eventEnd as string).trim() : '';

  if (start && end && partialDateEndMs(end) < partialDateStartMs(start)) {
    [eventStart, eventEnd] = [eventEnd, eventStart];
  }

  const eventOngoing = eventEnd ? false : fields.eventOngoing === true;

  return { eventStart, eventEnd, eventOngoing };
}
