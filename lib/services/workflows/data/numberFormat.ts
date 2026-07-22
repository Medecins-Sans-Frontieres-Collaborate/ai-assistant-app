import { DataColumnFormat } from '@/types/workflow';

/**
 * Formatted-number parsing and rendering: currency tokens (any Unicode
 * currency symbol, 'R$'-style letter+symbol pairs, ISO codes, 'kr') and
 * the two separator conventions (US 1,234.56 / EU 1.234,56). Values are
 * stored as plain numbers; the captured format lives on the column
 * (DataColumn.format) and is display-only.
 *
 * This module is a leaf — tableUtils imports it, never the reverse.
 */

export interface ParsedFormattedNumber {
  value: number;
  currency?: string;
  currencyPosition?: 'prefix' | 'suffix';
  /** Unambiguous separator evidence this cell contributes, if any. */
  styleEvidence?: 'us' | 'eu';
}

const PREFIX_CURRENCY_RE = /^([A-Za-z]{1,2}\p{Sc}|\p{Sc}|[A-Z]{3})\s*/u;
const SUFFIX_CURRENCY_RE = /\s*(\p{Sc}[A-Za-z]{1,2}|\p{Sc}|[A-Z]{3}|kr)$/u;
/** Space/apostrophe grouping must be exact thousands ("1 234", "1'234.5"). */
const SPACE_GROUPED_RE = /^\d{1,3}(?:[ \u00A0']\d{3})+(?:[.,]\d+)?$/;

function thousandsValid(part: string, sep: ',' | '.'): boolean {
  if (!part.includes(sep)) return /^\d+$/.test(part);
  const groups = part.split(sep);
  return (
    /^\d{1,3}$/.test(groups[0]) &&
    groups.slice(1).every((group) => /^\d{3}$/.test(group))
  );
}

function parseBody(
  raw: string,
  style?: 'us' | 'eu',
): { value: number; styleEvidence?: 'us' | 'eu' } | null {
  let s = raw.trim();
  if (/[ \u00A0']/.test(s)) {
    if (!SPACE_GROUPED_RE.test(s)) return null;
    s = s.replace(/[ \u00A0']/g, '');
  }
  if (!/^\d[\d.,]*$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal: '.' | ',' | null = null;
  let styleEvidence: 'us' | 'eu' | undefined;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators present: the later one is the decimal.
    decimal = lastDot > lastComma ? '.' : ',';
    styleEvidence = decimal === '.' ? 'us' : 'eu';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const index = Math.max(lastDot, lastComma);
    const single = s.indexOf(sep) === index;
    const digitsAfter = s.length - index - 1;
    if (!single) {
      decimal = null; // repeated separator → thousands
    } else if (digitsAfter !== 3) {
      // "3.77", "25,5" — a thousands reading is impossible.
      decimal = sep;
      styleEvidence = sep === '.' ? 'us' : 'eu';
    } else {
      // One separator with three digits after ("1,234" / "1.234") is
      // genuinely ambiguous; the column style decides, defaulting to
      // the US convention (matches legacy parsing).
      const effective = style ?? 'us';
      decimal =
        effective === 'us'
          ? sep === '.'
            ? '.'
            : null
          : sep === ','
            ? ','
            : null;
    }
  }

  const decIndex = decimal ? s.lastIndexOf(decimal) : -1;
  const intPart = decIndex >= 0 ? s.slice(0, decIndex) : s;
  const fracPart = decIndex >= 0 ? s.slice(decIndex + 1) : '';
  if (fracPart && !/^\d+$/.test(fracPart)) return null;
  const thousandsSep: ',' | '.' | null =
    decimal === '.'
      ? ','
      : decimal === ','
        ? '.'
        : lastDot >= 0
          ? '.'
          : lastComma >= 0
            ? ','
            : null;
  if (thousandsSep) {
    if (!thousandsValid(intPart, thousandsSep)) return null;
  } else if (!/^\d+$/.test(intPart)) {
    return null;
  }

  const value = Number(
    intPart.replace(/[.,]/g, '') + (fracPart ? `.${fracPart}` : ''),
  );
  return Number.isFinite(value) ? { value, styleEvidence } : null;
}

/**
 * Parses one cell as an optionally currency-tagged, locale-formatted
 * number. Returns null when the string does not read as a number.
 * Accepts "(45)" and "-$5" negatives; rejects mixed prefix+suffix.
 */
export function parseFormattedNumber(
  raw: string,
  style?: 'us' | 'eu',
): ParsedFormattedNumber | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  const paren = /^\((.+)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }

  let currency: string | undefined;
  let currencyPosition: 'prefix' | 'suffix' | undefined;
  const prefix = PREFIX_CURRENCY_RE.exec(s);
  if (prefix) {
    currency = prefix[1];
    currencyPosition = 'prefix';
    s = s.slice(prefix[0].length);
    if (s.startsWith('-')) {
      negative = true;
      s = s.slice(1).trim();
    }
  } else {
    const suffix = SUFFIX_CURRENCY_RE.exec(s);
    if (suffix) {
      currency = suffix[1];
      currencyPosition = 'suffix';
      s = s.slice(0, suffix.index);
    }
  }

  const body = parseBody(s, style);
  if (!body) return null;
  return {
    value: negative ? -body.value : body.value,
    ...(currency ? { currency, currencyPosition } : {}),
    ...(body.styleEvidence ? { styleEvidence: body.styleEvidence } : {}),
  };
}

/**
 * Column-level format detection over a value sample. Returns the format
 * to attach ({} = plain numbers, no metadata needed), or null when the
 * column should NOT be treated as formatted numbers: any cell that
 * parses neither as a formatted nor a plain number, or inconsistent
 * currency tokens (converting "$5"/"€5" to bare numbers would destroy
 * information).
 */
export function detectColumnNumberFormat(
  values: unknown[],
): DataColumnFormat | null {
  let us = 0;
  let eu = 0;
  let nonEmpty = 0;
  let prefixCount = 0;
  let suffixCount = 0;
  const tokens = new Set<string>();
  for (const value of values.slice(0, 200)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number') {
      nonEmpty += 1;
      continue;
    }
    if (typeof value === 'boolean') return null;
    const s = String(value).trim();
    if (!s) continue;
    nonEmpty += 1;
    const parsed = parseFormattedNumber(s);
    if (!parsed) {
      // Legacy plain-number forms the formatted parser rejects ("1e5").
      if (!Number.isNaN(Number(s.replace(/,/g, '')))) continue;
      return null;
    }
    if (parsed.styleEvidence === 'us') us += 1;
    else if (parsed.styleEvidence === 'eu') eu += 1;
    if (parsed.currency) {
      tokens.add(parsed.currency);
      if (parsed.currencyPosition === 'suffix') suffixCount += 1;
      else prefixCount += 1;
    }
  }
  if (nonEmpty === 0) return null;
  if (tokens.size > 1) return null;

  const format: DataColumnFormat = {};
  if (eu > us) format.numberStyle = 'eu';
  else if (us > 0) format.numberStyle = 'us';
  if (tokens.size === 1) {
    format.currency = [...tokens][0];
    if (suffixCount > prefixCount) format.currencyPosition = 'suffix';
  }
  return format;
}

/**
 * Renders a stored number with its column format ("$1,234.56",
 * "1.234,56 €"). Display-only — exports, prompts and comparisons keep
 * using the canonical formatCell.
 */
export function formatNumberForDisplay(
  value: number,
  format: DataColumnFormat,
): string {
  const text =
    format.numberStyle || format.currency
      ? new Intl.NumberFormat(format.numberStyle === 'eu' ? 'de-DE' : 'en-US', {
          maximumFractionDigits: 6,
        }).format(value)
      : String(value);
  if (!format.currency) return text;
  return format.currencyPosition === 'suffix'
    ? `${text} ${format.currency}`
    : `${format.currency}${text}`;
}
