/**
 * Character counting the way platforms count, with positions.
 *
 * Everything is expressed as UNITS over the original string (UTF-16 offsets),
 * so the same pass answers "how long is it", "where does it overflow" and
 * "where may I cut". Counting is by grapheme, so emoji, Arabic and CJK count
 * as readers and platforms see them rather than as UTF-16 code units.
 */

/**
 * How a target counts characters. These are generic counting schemes, not
 * channel knowledge: which target uses which is the kind's own table.
 *
 * - `graphemes`: what a reader sees; one emoji is one.
 * - `utf16`: code units, the way a plain `maxlength` counts; an emoji is two
 *   and a joined family eleven. Never under-counts a grapheme counter.
 * - `url-23`: graphemes, but every link costs a flat 23 (Mastodon).
 * - `x-weighted`: X's published weights: links 23, emoji and CJK two.
 * - `gsm7`: one SMS. Characters outside the GSM alphabet turn the WHOLE
 *   message into Unicode, which has room for 70 rather than 160.
 */
export type CountingRule =
  | 'graphemes'
  | 'utf16'
  | 'url-23'
  | 'x-weighted'
  | 'gsm7';

export interface CountUnit {
  start: number;
  end: number;
  weight: number;
}

/** X and Mastodon count every link as this many, whatever its length. */
export const X_URL_WEIGHT = 23;

/**
 * Characters that END a link. Platforms stop a link at CJK text and at
 * full-width punctuation even with no space between them; a pattern that ran
 * on to the next space counted a link plus 240 Chinese characters as 23.
 */
const URL_STOP =
  '\\s<>"\'\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{3FFFF}';

const LATIN = 'a-z0-9\u00C0-\u024F';

/**
 * What a platform treats as a link. BARE DOMAINS are links too
 * ("example.org/report" costs 23 on X), so those are matched as well: dotted
 * Latin labels ending in an alphabetic label of two or more letters, with an
 * optional path. The lookbehind is Latin-only on purpose, so a domain written
 * straight after Chinese text is still found. This over-matches a little
 * ("file.txt"), which is the safe direction: saying a post is longer than
 * the platform will count it never gets a post rejected; under-counting does.
 */
const URL_PATTERN = new RegExp(
  `\\b(?:https?:\\/\\/|www\\.)[^${URL_STOP}]+` +
    `|(?<![@_.\\-${LATIN}])(?:[${LATIN}](?:[${LATIN}\\-]{0,61}[${LATIN}])?\\.)+[a-z]{2,24}(?![${LATIN}])(?:\\/[^${URL_STOP}]*)?`,
  'giu',
);

/**
 * An emoji counts as 2 on X whatever it is made of. Flags are pairs of
 * regional indicators and keycaps end in U+20E3; neither is
 * Extended_Pictographic, so they are named here.
 */
const EMOJI_PATTERN =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/** The GSM 03.38 basic alphabet: one septet each. */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ!"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** The extension table: an escape plus the character, so two septets. */
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

/** One Unicode SMS holds 70 code units where a GSM one holds 160. */
export const SMS_UNICODE_PENALTY = 160 - 70;

/** The characters of `text` that force a Unicode SMS, each listed once. */
export function nonGsmCharacters(text: string): string[] {
  const found = new Set<string>();
  for (const char of text) {
    if (!GSM_BASIC.has(char) && !GSM_EXTENDED.has(char)) found.add(char);
  }
  return [...found];
}

/**
 * Code point ranges X counts as one character; everything else (CJK, most
 * symbols) counts as two. Mirrors the published twitter-text v3 config.
 */
const X_SINGLE_WEIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

let cachedSegmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter === undefined) {
    cachedSegmenter =
      typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return cachedSegmenter;
}

function graphemes(text: string, offset: number): CountUnit[] {
  const segmenter = graphemeSegmenter();
  const units: CountUnit[] = [];
  if (segmenter) {
    for (const part of segmenter.segment(text)) {
      units.push({
        start: offset + part.index,
        end: offset + part.index + part.segment.length,
        weight: 1,
      });
    }
    return units;
  }
  // No Segmenter: fall back to code points, which over-counts joined emoji
  // but never splits a surrogate pair.
  let index = 0;
  for (const char of text) {
    units.push({
      start: offset + index,
      end: offset + index + char.length,
      weight: 1,
    });
    index += char.length;
  }
  return units;
}

function xWeightOf(grapheme: string): number {
  if (EMOJI_PATTERN.test(grapheme)) return 2;
  let weight = 0;
  // X counts code points of the NFC form; the offsets stay those of the
  // original string because only the weight is taken from the normal form.
  for (const char of grapheme.normalize('NFC')) {
    const codePoint = char.codePointAt(0) ?? 0;
    const single = X_SINGLE_WEIGHT_RANGES.some(
      ([from, to]) => codePoint >= from && codePoint <= to,
    );
    weight += single ? 1 : 2;
  }
  return weight;
}

/** Trailing punctuation is prose, not part of the link. */
function trimUrlEnd(url: string): string {
  return url.replace(/[.,;:!?)\]}'"»”]+$/u, '');
}

export interface FoundLink {
  start: number;
  end: number;
  url: string;
  /** False for a bare domain ("msf.org"), which may be a false positive. */
  explicit: boolean;
}

/** Every link in `text`, the way a platform would find them. */
export function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrlEnd(match[0]);
    if (!url) continue;
    const start = match.index ?? 0;
    found.push({
      start,
      end: start + url.length,
      url,
      explicit: /^(?:https?:\/\/|www\.)/iu.test(url),
    });
  }
  return found;
}

/** UTF-16 code units, grouped per grapheme so a cut never splits one. */
function utf16Units(text: string): CountUnit[] {
  return graphemes(text, 0).map((unit) => ({
    ...unit,
    weight: unit.end - unit.start,
  }));
}

/**
 * One SMS. Inside the GSM alphabet a character is one septet (two for the
 * extension table). The first character outside it switches the whole
 * message to Unicode, so THAT character carries the 90 characters the
 * message loses: the total then passes 160 exactly when the Unicode message
 * passes 70, and "over by N" stays true in both encodings.
 */
function gsmUnits(text: string): CountUnit[] {
  const unicode = nonGsmCharacters(text).length > 0;
  let penaltyDue = unicode;
  return graphemes(text, 0).map((unit) => {
    const grapheme = text.slice(unit.start, unit.end);
    if (!unicode) {
      return { ...unit, weight: GSM_EXTENDED.has(grapheme) ? 2 : 1 };
    }
    let weight = unit.end - unit.start;
    if (penaltyDue && nonGsmCharacters(grapheme).length > 0) {
      weight += SMS_UNICODE_PENALTY;
      penaltyDue = false;
    }
    return { ...unit, weight };
  });
}

export function countUnits(rule: CountingRule, text: string): CountUnit[] {
  if (rule === 'graphemes') return graphemes(text, 0);
  if (rule === 'utf16') return utf16Units(text);
  if (rule === 'gsm7') return gsmUnits(text);

  const weigh = rule === 'x-weighted' ? xWeightOf : (): number => 1;
  const units: CountUnit[] = [];
  let cursor = 0;
  const pushText = (from: number, to: number): void => {
    for (const unit of graphemes(text.slice(from, to), from)) {
      units.push({
        ...unit,
        weight: weigh(text.slice(unit.start, unit.end)),
      });
    }
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrlEnd(match[0]);
    if (!url) continue;
    const start = match.index ?? 0;
    pushText(cursor, start);
    units.push({ start, end: start + url.length, weight: X_URL_WEIGHT });
    cursor = start + url.length;
  }
  pushText(cursor, text.length);
  return units;
}

export function countText(rule: CountingRule, text: string): number {
  let total = 0;
  for (const unit of countUnits(rule, text)) total += unit.weight;
  return total;
}

/**
 * UTF-16 offset at which `text` stops fitting in `limit`, or null when it
 * fits. Always falls on a unit boundary, so it never splits a grapheme or
 * a link.
 */
export function overflowIndex(
  rule: CountingRule,
  text: string,
  limit: number,
): number | null {
  let total = 0;
  for (const unit of countUnits(rule, text)) {
    total += unit.weight;
    if (total > limit) return unit.start;
  }
  return null;
}
