/**
 * Verbatim verification with positions.
 *
 * `normalizeForQuoteMatch` answers "is this excerpt in the source"; the proof
 * card also needs WHERE, in the original text, so it can show the passage
 * around the match. This module applies the same normalization one character
 * at a time and keeps a map back to the original offsets.
 */
import { DRAFTER_LIMITS } from '@/types/drafter';

export interface TextRange {
  start: number;
  end: number;
}

export interface Passage {
  before: string;
  match: string;
  after: string;
  /** True when `before` / `after` were cut from a longer text. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** An excerpt shorter than this proves nothing; it matches by accident. */
export const MIN_EXCERPT_CHARS = 8;

/** What Turndown puts a backslash before. */
const MARKDOWN_ESCAPABLE = /[\\*\-+=#`~[\]>_.]/u;

interface NormalizedText {
  text: string;
  /** Original offset of each normalized character. */
  map: number[];
}

function normalizeChar(char: string): string {
  if (/[‘’‚′`´]/u.test(char)) return "'";
  if (/[“”„″]/u.test(char)) return '"';
  if (/[–—−]/u.test(char)) return '-';
  if (char === '­') return '';
  return char.toLowerCase();
}

/**
 * Same result as `normalizeForQuoteMatch` (lib/utils/app/citationQuotes.ts),
 * plus the offset map. The two are pinned together by a test.
 */
export function normalizeWithMap(source: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    // A Markdown escape ("\[province\]") from a source saved as Markdown
    // before pages were converted to prose: the backslash was never on the
    // page, so it is not part of the words.
    if (char === '\\' && MARKDOWN_ESCAPABLE.test(source[i + 1] ?? '')) {
      continue;
    }
    if (/\s/u.test(char)) {
      if (text.length > 0 && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    const normalized = normalizeChar(char);
    if (!normalized) continue;
    if (pendingSpace >= 0) {
      text += ' ';
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    for (const unit of normalized) {
      text += unit;
      map.push(i);
    }
  }
  return { text, map };
}

/**
 * Where `excerpt` appears in `source`, as offsets into the ORIGINAL source,
 * or null when it does not appear verbatim (typography and whitespace aside).
 */
export function locateExcerpt(
  source: string,
  excerpt: string,
): TextRange | null {
  const needle = normalizeWithMap(excerpt).text;
  if (needle.length < MIN_EXCERPT_CHARS) return null;
  const haystack = normalizeWithMap(source);
  const at = haystack.text.indexOf(needle);
  if (at < 0) return null;
  const start = haystack.map[at];
  const end = haystack.map[at + needle.length - 1] + 1;
  return { start, end };
}

export function isVerbatim(source: string, excerpt: string): boolean {
  return locateExcerpt(source, excerpt) !== null;
}

/** The matched text with its surroundings, for the proof card. */
export function passageAround(
  source: string,
  range: TextRange,
  context: number = DRAFTER_LIMITS.PASSAGE_CONTEXT_CHARS,
): Passage {
  const from = Math.max(0, range.start - context);
  const to = Math.min(source.length, range.end + context);
  return {
    before: source.slice(from, range.start),
    match: source.slice(range.start, range.end),
    after: source.slice(range.end, to),
    clippedStart: from > 0,
    clippedEnd: to < source.length,
  };
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LETTER_CHAR = /\p{L}/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function isLetterChar(char: string | undefined): boolean {
  return char !== undefined && LETTER_CHAR.test(char);
}

/**
 * True when cutting `text` at `at` splits a word. Unicode-aware, because
 * `\b` treats "é" as a non-word character. With `apostropheJoins`, an
 * apostrophe between two letters is part of the word, so "didn't" cannot be
 * cut into "didn" (which would drop the negation) or "t".
 */
function splitsWord(
  text: string,
  at: number,
  apostropheJoins: boolean,
): boolean {
  if (at <= 0 || at >= text.length) return false;
  const before = text[at - 1];
  const after = text[at];
  if (isWordChar(before) && isWordChar(after)) return true;
  if (!apostropheJoins) return false;
  if (before === "'" && isLetterChar(text[at - 2]) && isLetterChar(after)) {
    return true;
  }
  return after === "'" && isLetterChar(before) && isLetterChar(text[at + 1]);
}

/**
 * Whether `text.slice(start, end)` begins and ends on a word boundary.
 * Expects normalized text (apostrophes already folded to `'`).
 */
export function isWordAligned(
  text: string,
  start: number,
  end: number,
  apostropheJoins = false,
): boolean {
  return (
    !splitsWord(text, start, apostropheJoins) &&
    !splitsWord(text, end, apostropheJoins)
  );
}

/** `word` appears in `haystack` as whole words, not inside another word. */
export function containsWholeWords(haystack: string, word: string): boolean {
  if (!word) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(word, from);
    if (at < 0) return false;
    if (isWordAligned(haystack, at, at + word.length)) return true;
    from = at + 1;
  }
}

/** A surname shorter than this matches by accident ("Li" in "earlier"). */
const MIN_SURNAME_CHARS = 3;

/**
 * Whether a speaker's name is stated near the excerpt. An attribution the
 * source does not carry is blanked for the user to fill, never kept on the
 * model's word. Matching is on whole words: "Ali" is not confirmed by
 * "quality".
 */
export function attributionNearExcerpt(
  source: string,
  range: TextRange,
  name: string,
  window = 600,
): boolean {
  const wanted = normalizeWithMap(name).text;
  if (!wanted) return false;
  const around = source.slice(
    Math.max(0, range.start - window),
    Math.min(source.length, range.end + window),
  );
  const haystack = normalizeWithMap(around).text;
  if (containsWholeWords(haystack, wanted)) return true;
  // "Dr Amina Yusuf" is often "Yusuf" or "Dr Yusuf" by the quote itself.
  const parts = wanted
    .split(' ')
    .filter((part) => part.length >= MIN_SURNAME_CHARS);
  const last = parts[parts.length - 1];
  return !!last && last !== wanted && containsWholeWords(haystack, last);
}
