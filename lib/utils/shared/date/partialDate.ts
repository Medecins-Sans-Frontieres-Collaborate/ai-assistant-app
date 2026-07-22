/**
 * The PREDECESSOR date shape for extracted event data: strings whose SHAPE
 * encodes precision — "2026", "2026-03", "2026-03-12".
 *
 * Superseded by `EventRange` (see ./eventRange.ts), which carries an
 * explicit precision and reaches minute resolution. Nothing writes this
 * shape any more, but every map saved before the change still stores it, so
 * these parsers survive for exactly one caller: `eventRangeFromLegacy`,
 * which converts on read. Display, normalization, and comparison helpers
 * were removed with the shape — reintroducing one would mean interpreting
 * legacy dates somewhere other than the single conversion point.
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
