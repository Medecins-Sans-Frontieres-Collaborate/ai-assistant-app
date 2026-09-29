/**
 * Sentence and clause segmentation for the citation step, and the key a
 * citation verdict is stored under. Nothing here judges a sentence: the
 * lexical "statement" scorer that once lived in this file scored verb and
 * number swaps as fully supported and let word lists collide across
 * languages, so attribution is now the model's answer (core/citations.ts)
 * and code keeps only what that step needs: where the sentences are, and
 * how to recognise one again after typography-only edits.
 */
import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';
import { diffWords } from '@/lib/utils/shared/review/editApplication';

import { DRAFTER_LIMITS } from '@/types/drafter';

// Imports from ./grounding are only used inside functions: the two modules
// import each other, and nothing here may run at module load.
import { URL_OR_TAG_PATTERN, findNumbers } from './grounding';
import { TextRange, normalizeWithMap } from './verify';
import {
  ABBREVIATIONS_ALWAYS,
  ABBREVIATIONS_BEFORE_NUMBER,
  CAUSAL_CONNECTORS,
  CLAUSE_CONJUNCTIONS,
  CONTRAST_WORDS,
  MODALS,
  SAYING_VERBS,
  STOP_WORDS,
  foldKey,
  isPolarityWord,
} from './wordLists';

/** A clause is cut off only when both halves keep this many content keys. */
export const MIN_STATEMENT_KEYS = 3;
export const STEM_PREFIX = 5;

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const WHITESPACE = /\s/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const ARABIC = /\p{Script=Arabic}/u;
const ONLY_DIGITS = /^\p{N}+$/u;
/** Linear and non-backtracking: a word, with apostrophes joining its parts. */
const TOKEN = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu;
const SENTENCE_END_CHARS = '.!?…。！？؟';
const CLOSERS = '"\'”’»)]';
const BULLETS = '-•*–—';
const MAX_ABBREVIATION_CHARS = 12;
const ARABIC_CLITICS = 'وفبلك';
const ARABIC_SUFFIXES = ['ات', 'ون', 'ين', 'ها', 'هم', 'ة', 'ه'];
const LEADING_KEY_JUNK = /^[\s"'«([]+/u;
const TRAILING_KEY_JUNK = /[\s.,;:!?…"'»«)\]]+$/u;

function isLetterOrNumber(char: string | undefined): boolean {
  return char !== undefined && LETTER_OR_NUMBER.test(char);
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && LETTER.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && DIGIT.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.test(char);
}

/* ------------------------------------------------------------------ */
/* Sentences and clauses                                               */
/* ------------------------------------------------------------------ */

/** Walks sorted ranges once, in text order. */
class RangeCursor {
  private index = 0;

  constructor(private readonly ranges: TextRange[]) {}

  /** The range covering `at`, if one does. */
  at(at: number): TextRange | null {
    while (
      this.index < this.ranges.length &&
      this.ranges[this.index].end <= at
    ) {
      this.index += 1;
    }
    const range = this.ranges[this.index];
    return range && at >= range.start ? range : null;
  }
}

function sortedRanges(ranges: TextRange[]): TextRange[] {
  return [...ranges].sort((a, b) => a.start - b.start);
}

/** The letters and digits just before `end`, at most a few characters. */
function wordEndingAt(text: string, end: number): string {
  let start = end;
  while (
    start > 0 &&
    end - start < MAX_ABBREVIATION_CHARS &&
    isLetterOrNumber(text[start - 1])
  ) {
    start -= 1;
  }
  return text.slice(start, end);
}

function nextNonSpace(text: string, from: number): string | undefined {
  let i = from;
  while (i < text.length && isSpace(text[i])) i += 1;
  return text[i];
}

/**
 * `text[start, end)` without surrounding whitespace or a leading bullet, or
 * null when nothing that could be a statement (a letter or a digit) is left.
 */
function trimRange(text: string, start: number, end: number): TextRange | null {
  let from = start;
  let to = end;
  while (from < to && isSpace(text[from])) from += 1;
  if (from < to && BULLETS.includes(text[from]) && isSpace(text[from + 1])) {
    from += 1;
    while (from < to && isSpace(text[from])) from += 1;
  }
  while (to > from && isSpace(text[to - 1])) to -= 1;
  for (let i = from; i < to; i += 1) {
    if (isLetterOrNumber(text[i])) return { start: from, end: to };
  }
  return null;
}

/** Sentences of `text`, never cut inside a masked range. */
function sentenceRanges(text: string, masked: TextRange[]): TextRange[] {
  const masks = new RangeCursor(masked);
  const sentences: TextRange[] = [];
  let start = 0;
  const cut = (at: number): void => {
    if (at > start) {
      const trimmed = trimRange(text, start, at);
      if (trimmed) sentences.push(trimmed);
    }
    start = at;
  };
  let i = 0;
  while (i < text.length) {
    const mask = masks.at(i);
    if (mask) {
      i = mask.end;
      continue;
    }
    const char = text[i];
    if (char === '\n') {
      cut(i);
      i += 1;
      while (i < text.length && isSpace(text[i])) i += 1;
      start = i;
      continue;
    }
    if (!SENTENCE_END_CHARS.includes(char)) {
      i += 1;
      continue;
    }
    if (char === '.') {
      // "1.5", "J. Smith", "Dr. Yusuf", "No. 5".
      if (isDigit(text[i - 1]) && isDigit(text[i + 1])) {
        i += 1;
        continue;
      }
      const word = foldKey(wordEndingAt(text, i));
      if (
        (word.length === 1 && isLetter(word)) ||
        ABBREVIATIONS_ALWAYS.has(word) ||
        (ABBREVIATIONS_BEFORE_NUMBER.has(word) &&
          isDigit(nextNonSpace(text, i + 1)))
      ) {
        i += 1;
        continue;
      }
    }
    let j = i + 1;
    while (j < text.length && CLOSERS.includes(text[j])) j += 1;
    if (j === text.length || isSpace(text[j])) cut(j);
    i = j;
  }
  cut(text.length);
  return sentences;
}

/** The word starting at `at` (letters, marks, digits), folded. */
function wordAt(text: string, at: number): { word: string; end: number } {
  let end = at;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  return { word: foldKey(text.slice(at, end)), end };
}

/**
 * Clause cuts inside one sentence: after ';', after ' : ', at a spaced dash,
 * or at a clause conjunction (after a comma, or bare). A cut is taken only
 * when both sides keep MIN_STATEMENT_KEYS keys, greedily left to right.
 */
function clauseRanges(
  text: string,
  sentence: TextRange,
  masked: TextRange[],
): TextRange[] {
  const local = text.slice(sentence.start, sentence.end);
  const keyStarts = contentKeys(local)
    .keys.map((key) => key.range.start)
    .sort((a, b) => a - b);
  if (keyStarts.length < 2 * MIN_STATEMENT_KEYS) return [sentence];
  const masks = new RangeCursor(
    masked.map((range) => ({
      start: range.start - sentence.start,
      end: range.end - sentence.start,
    })),
  );
  const out: TextRange[] = [];
  let lastCut = 0;
  /** Keys before the running scan position; `keyStarts` is walked once. */
  let seen = 0;
  let sinceCut = 0;
  const tryCut = (at: number): void => {
    while (seen < keyStarts.length && keyStarts[seen] < at) {
      seen += 1;
      sinceCut += 1;
    }
    const right = keyStarts.length - seen;
    if (sinceCut < MIN_STATEMENT_KEYS || right < MIN_STATEMENT_KEYS) return;
    const trimmed = trimRange(
      text,
      sentence.start + lastCut,
      sentence.start + at,
    );
    if (trimmed) out.push(trimmed);
    lastCut = at;
    sinceCut = 0;
  };
  let i = 0;
  while (i < local.length) {
    const mask = masks.at(i);
    if (mask) {
      i = mask.end;
      continue;
    }
    const char = local[i];
    if (char === ';') {
      tryCut(i + 1);
      i += 1;
      continue;
    }
    if (char === ':' && isSpace(local[i + 1]) && !isDigit(local[i - 1])) {
      tryCut(i + 1);
      i += 1;
      continue;
    }
    if (
      (char === '–' || char === '—' || char === '-') &&
      isSpace(local[i - 1]) &&
      isSpace(local[i + 1])
    ) {
      tryCut(i + 1);
      i += 1;
      continue;
    }
    if (char === ',' || char === '،') {
      let j = i + 1;
      while (j < local.length && isSpace(local[j])) j += 1;
      if (j > i + 1 && j < local.length) {
        const { word, end } = wordAt(local, j);
        const arabicPrefixed = char === '،' && word.startsWith('و');
        if (CLAUSE_CONJUNCTIONS.has(word) || arabicPrefixed) {
          tryCut(j);
          i = end;
          continue;
        }
      }
      i += 1;
      continue;
    }
    if (isSpace(char) && isLetter(local[i + 1])) {
      const { word, end } = wordAt(local, i + 1);
      if (CLAUSE_CONJUNCTIONS.has(word)) tryCut(i + 1);
      i = end;
      continue;
    }
    i += 1;
  }
  const tail = trimRange(text, sentence.start + lastCut, sentence.end);
  if (tail) out.push(tail);
  return out.length > 0 ? out : [sentence];
}

/**
 * The statements of `text`: sentences, cut into clauses where both halves
 * can stand alone. A period inside a masked range (a quotation) never cuts,
 * and a span may contain a quotation. Raw, trimmed offsets.
 */
export function statementSpans(text: string, masked: TextRange[]): TextRange[] {
  const masks = sortedRanges(masked);
  return sentenceRanges(text, masks).flatMap((sentence) =>
    clauseRanges(text, sentence, masks),
  );
}

/* ------------------------------------------------------------------ */
/* Content keys (for clause cuts and quotation insertions)             */
/* ------------------------------------------------------------------ */

export interface Key {
  key: string;
  /** Raw offsets into the text given. */
  range: TextRange;
  kind: 'word' | 'number';
}

export interface ContentKeys {
  keys: Key[];
}

/**
 * A short stem, so "patients" and "patient", "traités" and "traitement"
 * share a key. Arabic: the article and one clitic-plus-article prefix go,
 * then one common suffix; every script keeps its first STEM_PREFIX letters.
 */
export function stemLite(word: string): string {
  let w = word;
  if (ARABIC.test(w)) {
    if (w.length >= 5 && w.startsWith('ال')) w = w.slice(2);
    else if (
      w.length >= 5 &&
      ARABIC_CLITICS.includes(w[0]) &&
      w.slice(1, 3) === 'ال'
    ) {
      w = w.slice(3);
    }
    if (w.length >= 4) {
      for (const suffix of ARABIC_SUFFIXES) {
        if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
          w = w.slice(0, w.length - suffix.length);
          break;
        }
      }
    }
  }
  return w.length <= 4 ? w : w.slice(0, STEM_PREFIX);
}

/** `text` with the given ranges and every link, hashtag or handle blanked. */
function blankOut(text: string, skip: TextRange[]): string {
  const blank = text
    .replace(URL_OR_TAG_PATTERN, (match) => ' '.repeat(match.length))
    .split('');
  for (const range of skip) {
    const end = Math.min(blank.length, range.end);
    for (let i = Math.max(0, range.start); i < end; i += 1) blank[i] = ' ';
  }
  return blank.join('');
}

/**
 * The content keys of a text: canonical numbers and stemmed content words.
 * Grammar words, polarity / contrast / causal / modal words and verbs of
 * saying yield no key. Used to decide where a sentence may be cut into
 * clauses, and which words a [bracketed insertion] in a quotation may
 * carry; never to judge a sentence. A word is tested whole and without its
 * elided prefix ("l'hôpital" is "hôpital").
 */
export function contentKeys(text: string, skip: TextRange[] = []): ContentKeys {
  const blank = blankOut(text, skip);
  const found: Key[] = [];
  for (const number of findNumbers(blank)) {
    found.push({
      key: `#${number.canonical}`,
      range: { start: number.start, end: number.end },
      kind: 'number',
    });
  }
  const normalized = normalizeWithMap(blank);
  for (const match of normalized.text.matchAll(TOKEN)) {
    const token = match[0];
    if (ONLY_DIGITS.test(token)) continue;
    const at = match.index ?? 0;
    const range = {
      start: normalized.map[at],
      end: normalized.map[at + token.length - 1] + 1,
    };
    const whole = foldKey(token);
    const parts = token.split("'").filter((part) => part.length > 2);
    const bare = parts.length > 0 ? foldKey(parts.join('')) : '';
    const forms = bare && bare !== whole ? [whole, bare] : [whole];
    if (
      forms.some(
        (form) =>
          isPolarityWord(form) ||
          CONTRAST_WORDS.has(form) ||
          CAUSAL_CONNECTORS.has(form) ||
          MODALS.has(form),
      )
    ) {
      continue;
    }
    if (bare.length < 2) continue;
    if (STOP_WORDS.has(bare) || SAYING_VERBS.has(bare)) continue;
    found.push({ key: stemLite(bare), range, kind: 'word' });
  }
  const keys: Key[] = [];
  const seen = new Set<string>();
  for (const key of found) {
    if (seen.has(key.key)) continue;
    seen.add(key.key);
    keys.push(key);
  }
  return { keys };
}

/* ------------------------------------------------------------------ */
/* Verdict keys and edit ranges                                        */
/* ------------------------------------------------------------------ */

/**
 * The key a model verdict is stored under: the sentence as compared, so a
 * typography-only change keeps the verdict and any change of words drops it.
 */
export function statementKey(text: string): string {
  return normalizeForQuoteMatch(text)
    .replace(LEADING_KEY_JUNK, '')
    .replace(TRAILING_KEY_JUNK, '')
    .slice(0, DRAFTER_LIMITS.MAX_CLAIM_CHARS);
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Where `after` differs from `before`, as ranges into `after`: an insertion
 * or replacement is the new words, a pure deletion a point. The common
 * prefix and suffix are trimmed to word boundaries first, so the word diff
 * only sees the edit.
 */
export function changedRanges(before: string, after: string): TextRange[] {
  if (before === after) return [];
  const shortest = Math.min(before.length, after.length);
  // A boundary sits next to whitespace (or at either end of the text).
  const boundary = (at: number): boolean =>
    at <= 0 ||
    at >= before.length ||
    isSpace(before[at - 1]) ||
    isSpace(before[at]);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  while (prefix > 0 && !boundary(prefix)) prefix -= 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  while (suffix > 0 && !boundary(before.length - suffix)) suffix -= 1;
  const parts = diffWords(
    before.slice(prefix, before.length - suffix),
    after.slice(prefix, after.length - suffix),
  );
  const ranges: TextRange[] = [];
  let pos = prefix;
  for (const part of parts) {
    if (part.kind === 'same') {
      pos += part.text.length;
    } else if (part.kind === 'ins') {
      ranges.push({ start: pos, end: pos + part.text.length });
      pos += part.text.length;
    } else {
      ranges.push({ start: pos, end: pos });
    }
  }
  return mergeRanges(ranges);
}
