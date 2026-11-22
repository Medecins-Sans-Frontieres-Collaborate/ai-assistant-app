/**
 * WHERE A DRAFT'S VALUES ARE STATED: a brand book drafted from a guide is
 * a model's reading of it, so each colour, typeface and word of the draft
 * is looked up in the guide's own text and given the page it is stated on.
 * A value found nowhere is not necessarily wrong (a guide can show a
 * colour as a swatch only, and a spelling rule implies the spelling to
 * avoid), but it is the model's inference, and the admin is told so.
 *
 * Pure: the editor shows the result, tests bracket it.
 */
import { comparableText } from '@/lib/utils/shared/documents/documentModel';

import { BrandBookBody } from './brandBook';
import { normalizeHex } from './brandColor';

/** One page of the guide's text. */
export interface GuidePageText {
  page: number;
  text: string;
}

/**
 * The page each of a draft's values is stated on, or null when the guide's
 * text does not state it. Keys are {@link groundingKey}s of the values, so
 * a value the admin has since edited has no entry (nothing is claimed
 * about it).
 */
export interface DraftGrounding {
  colors: Record<string, number | null>;
  fonts: Record<string, number | null>;
  terms: Record<string, number | null>;
}

/** How a value is looked up in a {@link DraftGrounding} list. */
export function groundingKey(value: string): string {
  return comparableText(value);
}

/** Most characters between the numbers of a colour given as R, G and B. */
const RGB_GAP_CHARS = 12;

/**
 * A colour as a guide may state it: its hex value, with or without `#`,
 * or its red, green and blue in that order ("R: 238 / G: 0 / B: 0").
 */
function colorPatterns(hex: string): RegExp[] {
  const digits = normalizeHex(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((at) =>
    parseInt(digits.slice(at, at + 2), 16),
  );
  const gap = `[^0-9]{1,${RGB_GAP_CHARS}}`;
  return [
    new RegExp(`(?<![0-9a-f])${digits}(?![0-9a-f])`, 'i'),
    new RegExp(`(?<![0-9])${r}${gap}${g}${gap}${b}(?![0-9])`),
  ];
}

/**
 * Finds where a draft's values are stated in its guide.
 *
 * @param book - The drafted book.
 * @param pages - The guide's text, page by page, in page order.
 * @returns The first page stating each palette and neutral colour, each
 *   typeface and substitute, and each word to use or avoid (and the words
 *   listed with it).
 */
export function groundDraft(
  book: Pick<BrandBookBody, 'palette' | 'neutrals' | 'fonts' | 'language'>,
  pages: readonly GuidePageText[],
): DraftGrounding {
  const comparable = pages.map(({ page, text }) => ({
    page,
    raw: text,
    text: comparableText(text),
  }));
  const pageOfText = (value: string): number | null => {
    const wanted = groundingKey(value);
    if (!wanted) return null;
    return comparable.find(({ text }) => text.includes(wanted))?.page ?? null;
  };
  const pageOfColor = (hex: string): number | null => {
    const patterns = colorPatterns(hex);
    return (
      comparable.find(({ raw }) =>
        patterns.some((pattern) => pattern.test(raw)),
      )?.page ?? null
    );
  };
  const listed = (
    values: readonly string[],
    find: (value: string) => number | null,
    key: (value: string) => string,
  ): Record<string, number | null> =>
    Object.fromEntries(values.map((value) => [key(value), find(value)]));

  const terms = [...book.language.preferred, ...book.language.banned].flatMap(
    (entry) => [entry.term, ...entry.alternatives],
  );
  return {
    colors: listed(
      [...book.palette.map((color) => color.hex), ...book.neutrals],
      pageOfColor,
      normalizeHex,
    ),
    fonts: listed(
      book.fonts.flatMap((font) => [font.family, ...font.substitutes]),
      pageOfText,
      groundingKey,
    ),
    terms: listed(terms, pageOfText, groundingKey),
  };
}

/** How many of a list's values were found, and how many there are. */
export function groundingCount(list: Record<string, number | null>): {
  found: number;
  total: number;
} {
  const pages = Object.values(list);
  return {
    found: pages.filter((page) => page !== null).length,
    total: pages.length,
  };
}
