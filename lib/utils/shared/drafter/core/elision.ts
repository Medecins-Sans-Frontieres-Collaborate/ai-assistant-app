/**
 * Elided quotations: "We had no clean water … for eleven days" is verbatim
 * when every run between the ellipses is found, in order, inside ONE brief
 * item, and nothing left out turns the meaning. A [bracketed insertion] of
 * a few words is skipped for matching but may hold no digit, no number or
 * magnitude word and no polarity word, and only words the item already has.
 *
 * An ellipsis the SPEAKER wrote ("No... we had nothing left") is part of
 * the quotation, not a gap: the whole text is tried first, ellipsis and all,
 * and only when that fails is the ellipsis read as words left out.
 *
 * Fails closed: a broken rule returns null and the quotation is ungrounded,
 * never silently accepted. Hand-written scanners only; the only regexes are
 * small anchored ones on a bracket's content or a single word.
 */
import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';

import { TextRange, isWordAligned } from './verify';
import {
  CLAUSE_CONJUNCTIONS,
  SAYING_VERBS,
  STOP_WORDS,
  foldKey,
  isContrastWord,
  isNegatorWord,
  isPolarityWord,
  isQuantityWord,
} from './wordLists';

/** A run of the speaker's words shorter than this is not evidence. */
export const MIN_FRAGMENT_WORDS = 2;
/** Below this many words a quoted string is a label, not a quotation. */
export const MIN_QUOTE_WORDS = 3;
export const MAX_INSERTION_WORDS = 5;
/** Normalized characters an ellipsis may leave out of the item. */
export const MAX_ELISION_GAP_CHARS = 200;
/**
 * Words an INNER ellipsis may leave out. Past this the two ends no longer
 * read as one sentence ("The new deal … affordable generic versions"), so
 * the quotation is verbatim in letter and incomprehensible in fact.
 */
export const MAX_ELISION_GAP_WORDS = 8;
/** First-fragment occurrences tried before giving up on a hostile item. */
export const MAX_MATCH_ATTEMPTS = 64;
/** How far back a negation is looked for within one clause. */
export const MAX_NEGATION_LOOKBACK_WORDS = 8;

const SENTENCE_ENDS = '.!?…:';
/** Where a clause ends: a sentence end, or the pause a negation does not cross. */
const CLAUSE_ENDS = `${SENTENCE_ENDS};,`;
const NAME_WORD_CHAR = /[\p{L}\p{M}\p{N}']/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Words in a normalized run of the item (apostrophes join, digits count). */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
const GAP_IN_BRACKETS = /^(?:\.\s?\.\s?\.|…)$/u;
const DOTTED_GAP = /\.(?:\s*\.){2,}/uy;
const PARENTHESISED_GAP = /\(\s*(?:…|\.(?:\s*\.){2,})\s*\)/uy;
/** Punctuation that may trail a gap ("…," "…." "…!") without being words. */
const GAP_TAIL = /[\s.,;:!?…]/u;
const TRAILING_PUNCTUATION = /[\s.,;:!?…]+$/u;
const APOSTROPHE_PREFIX = /^\p{L}{1,2}'/u;
const WORD_BREAK = /[^\p{L}\p{M}\p{N}']+/u;
/** Symbols that state or scale a quantity; never the writer's to insert. */
const QUANTITY_SYMBOL = /[\p{Nd}%‰$€£¥#+×]/u;
const THREE_DOTS = /\.\s?\.\s?\./gu;

/** "l'hôpital" → "hôpital": a one- or two-letter elided article is not the word. */
function dropApostrophePrefix(word: string): string {
  return word.replace(APOSTROPHE_PREFIX, '');
}

/**
 * The lookup forms of the words in a normalized run of text. A word with an
 * elided prefix is listed both ways, because "n'avons" negates as a whole
 * and "qu'aucun" only once the prefix is gone.
 */
function lookupWords(normalized: string): string[] {
  const forms: string[] = [];
  for (const token of normalized.split(WORD_BREAK)) {
    if (!token) continue;
    const whole = foldKey(token);
    const bare = foldKey(dropApostrophePrefix(token));
    forms.push(whole);
    if (bare !== whole) forms.push(bare);
  }
  return forms;
}

/**
 * A negator governs `at`: one sits earlier in the same clause ("did not
 * have enough water" refuses "enough water"), up to a bounded number of
 * words back. A clause break or a joining conjunction ends the search, and
 * so does `floor`: words before it are already part of the quotation.
 */
export function negatedBefore(text: string, at: number, floor = 0): boolean {
  let end = at;
  for (let seen = 0; seen < MAX_NEGATION_LOOKBACK_WORDS; seen += 1) {
    while (end > floor && !NAME_WORD_CHAR.test(text[end - 1])) {
      if (CLAUSE_ENDS.includes(text[end - 1])) return false;
      end -= 1;
    }
    if (end <= floor) return false;
    let start = end;
    while (start > floor && NAME_WORD_CHAR.test(text[start - 1])) start -= 1;
    const forms = lookupWords(text.slice(start, end).replace(/^'+|'+$/gu, ''));
    if (forms.some(isNegatorWord)) return true;
    if (forms.some((word) => CLAUSE_CONJUNCTIONS.has(word))) return false;
    end = start;
  }
  return false;
}

export interface ParsedQuotation {
  fragments: Array<{
    /** Raw offsets into the quotation's inner text. */
    raw: TextRange;
    /** normalizeForQuoteMatch of the run. */
    text: string;
    /** Last fragment only: `text` without a trailing full stop or comma. */
    bare?: string;
    words: number;
  }>;
  insertions: Array<{ start: number; end: number; words: string[] }>;
  /** One fragment, no gap, no insertion: today's whole-quotation match. */
  plain: boolean;
  /** The quotation opens with an ellipsis: words before it were left out. */
  leadingGap: boolean;
  /** The quotation closes with an ellipsis: words after it were left out. */
  trailingGap: boolean;
}

type Token =
  | { kind: 'gap' }
  | { kind: 'insert'; start: number; end: number; words: string[] }
  | { kind: 'fragment'; start: number; end: number };

/** The words of a bracketed insertion, or null when it breaks a rule. */
function insertionWords(content: string): string[] | null {
  const count = content.split(/\s+/u).filter(Boolean).length;
  if (count === 0 || count > MAX_INSERTION_WORDS) return null;
  if (QUANTITY_SYMBOL.test(content)) return null;
  const words: string[] = [];
  for (const token of normalizeForQuoteMatch(content)
    .split(WORD_BREAK)
    .filter(Boolean)) {
    // Both spellings are tested: "n'avons" negates before its prefix goes.
    const whole = foldKey(token);
    const word = foldKey(dropApostrophePrefix(token));
    if (isPolarityWord(whole) || isPolarityWord(word)) return null;
    if (isQuantityWord(whole) || isQuantityWord(word)) return null;
    words.push(word);
  }
  // A symbol-only insertion has nothing to check and is refused as such.
  return words.length === 0 ? null : words;
}

function tokenize(inner: string): Token[] | null {
  const tokens: Token[] = [];
  let fragmentStart = -1;
  const closeFragment = (at: number): void => {
    if (fragmentStart >= 0) {
      tokens.push({ kind: 'fragment', start: fragmentStart, end: at });
      fragmentStart = -1;
    }
  };
  let i = 0;
  const gapAt = (at: number, length: number): void => {
    closeFragment(at);
    tokens.push({ kind: 'gap' });
    i = at + length;
    // "…," "…." "…!": punctuation after a gap is nobody's words.
    while (i < inner.length && GAP_TAIL.test(inner[i])) i += 1;
  };
  while (i < inner.length) {
    const char = inner[i];
    if (char === '[') {
      const close = inner.indexOf(']', i + 1);
      const nested = inner.indexOf('[', i + 1);
      if (close >= 0 && (nested < 0 || nested > close)) {
        const content = inner.slice(i + 1, close).trim();
        if (GAP_IN_BRACKETS.test(content)) {
          gapAt(i, close + 1 - i);
        } else {
          const words = insertionWords(content);
          if (!words) return null;
          closeFragment(i);
          tokens.push({ kind: 'insert', start: i, end: close + 1, words });
          i = close + 1;
        }
        continue;
      }
      if (close >= 0) return null;
      // An unclosed bracket is only a character of the quotation.
    } else if (char === '(') {
      PARENTHESISED_GAP.lastIndex = i;
      const match = PARENTHESISED_GAP.exec(inner);
      if (match) {
        gapAt(i, match[0].length);
        continue;
      }
    } else if (char === '…') {
      gapAt(i, 1);
      continue;
    } else if (char === '.') {
      DOTTED_GAP.lastIndex = i;
      const match = DOTTED_GAP.exec(inner);
      if (match) {
        gapAt(i, match[0].length);
        continue;
      }
    }
    if (fragmentStart < 0 && !/\s/u.test(char)) fragmentStart = i;
    i += 1;
  }
  closeFragment(inner.length);
  return tokens;
}

function parseTokens(inner: string, tokens: Token[]): ParsedQuotation | null {
  const insertions: ParsedQuotation['insertions'] = [];
  let sawGap = false;
  let sawInsert = false;
  const fragments: ParsedQuotation['fragments'] = [];
  for (const token of tokens) {
    if (token.kind === 'gap') {
      sawGap = true;
      continue;
    }
    if (token.kind === 'insert') {
      sawInsert = true;
      insertions.push({
        start: token.start,
        end: token.end,
        words: token.words,
      });
      continue;
    }
    // Trailing whitespace before a gap or a bracket is not the speaker's.
    let end = token.end;
    while (end > token.start && /\s/u.test(inner[end - 1])) end -= 1;
    const text = normalizeForQuoteMatch(inner.slice(token.start, end));
    if (!text) continue;
    fragments.push({
      raw: { start: token.start, end },
      text,
      words: text.split(' ').length,
    });
  }
  if (fragments.length === 0) return null;
  if (fragments.some((fragment) => fragment.words < MIN_FRAGMENT_WORDS)) {
    return null;
  }
  const total = fragments.reduce((sum, fragment) => sum + fragment.words, 0);
  if (total < MIN_QUOTE_WORDS) return null;
  const last = fragments[fragments.length - 1];
  // A post may end a quotation with a full stop the brief item lacks.
  last.bare = last.text.replace(TRAILING_PUNCTUATION, '');
  return {
    fragments,
    insertions,
    plain: !sawGap && !sawInsert,
    leadingGap: tokens[0]?.kind === 'gap',
    trailingGap: tokens[tokens.length - 1]?.kind === 'gap',
  };
}

/**
 * Reads a quotation's inner text into verbatim fragments and what stands
 * between them. Null when a rule is broken: a nested bracket, an insertion
 * too long or holding a digit, a quantity or a polarity word, a fragment of
 * one word, or fewer than MIN_QUOTE_WORDS verbatim words in all.
 */
export function parseQuotation(inner: string): ParsedQuotation | null {
  const tokens = tokenize(inner);
  return tokens ? parseTokens(inner, tokens) : null;
}

export interface QuoteMatch {
  /** Matched runs, offsets into the normalized item text, in order. */
  pieces: TextRange[];
  /** Words were left out or added: false when the item reads the same. */
  elided: boolean;
  /** Raw offsets into `inner` of the speaker's own words. */
  verbatim: TextRange[];
  /** Raw offsets into `inner` of [bracketed insertions]. */
  insertions: TextRange[];
}

/**
 * `needle` in `haystack` at or after `from`, on word boundaries ("id not
 * have enough wat" is not a quotation) and not as the tail of a negation.
 * `floor` bounds the negation lookback: a run after a gap is not negated by
 * words the quotation already carries before the gap.
 */
function firstAligned(
  haystack: string,
  needle: string,
  from: number,
  floor = 0,
): number | null {
  if (!needle) return null;
  let at = haystack.indexOf(needle, from);
  while (at >= 0) {
    if (
      isWordAligned(haystack, at, at + needle.length, true) &&
      !negatedBefore(haystack, at, floor)
    ) {
      return at;
    }
    at = haystack.indexOf(needle, at + 1);
  }
  return null;
}

/**
 * Where a fragment sits in the item at or after `from`, `bare` allowed.
 * `floor` is where the negation lookback stops (see firstAligned).
 */
function locateFragment(
  haystack: string,
  fragment: ParsedQuotation['fragments'][number],
  from: number,
  allowBare: boolean,
  floor = 0,
): TextRange | null {
  const at = firstAligned(haystack, fragment.text, from, floor);
  if (at !== null) return { start: at, end: at + fragment.text.length };
  if (!allowBare || !fragment.bare || fragment.bare === fragment.text) {
    return null;
  }
  const bareAt = firstAligned(haystack, fragment.bare, from, floor);
  return bareAt === null
    ? null
    : { start: bareAt, end: bareAt + fragment.bare.length };
}

/** Every start where `needle` is aligned and not negated, in order. */
function alignedOccurrences(haystack: string, needle: string): number[] {
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const at = firstAligned(haystack, needle, from);
    if (at === null) return starts;
    starts.push(at);
    from = at + 1;
  }
}

/** A fragment ends in a negator or a scope word, in either spelling. */
function endsInPolarityWord(text: string): boolean {
  const words = text.split(' ');
  const tail = words[words.length - 1].replace(TRAILING_PUNCTUATION, '');
  return lookupWords(tail).some(isPolarityWord);
}

/** The words an ellipsis left out may not turn or contrast the meaning. */
function gapTurnsMeaning(gap: string): boolean {
  return lookupWords(gap).some(
    (word) => isPolarityWord(word) || isContrastWord(word),
  );
}

/** The item's words from the previous sentence end up to `at`. */
function clauseBefore(text: string, at: number): string {
  let start = at;
  while (start > 0 && !SENTENCE_ENDS.includes(text[start - 1])) start -= 1;
  return text.slice(start, at);
}

/** The item's words from `at` up to the next sentence end. */
function clauseAfter(text: string, at: number): string {
  let end = at;
  while (end < text.length && !SENTENCE_ENDS.includes(text[end])) end += 1;
  return text.slice(at, end);
}

/** "…, but we could not": the first word left out turns what was kept. */
function startsWithTurn(tail: string): boolean {
  const words = lookupWords(tail);
  if (words.length === 0) return false;
  const first = words[0];
  const twin = words[1] !== undefined && tail.includes("'") ? words[1] : first;
  return (
    isPolarityWord(first) ||
    isContrastWord(first) ||
    isPolarityWord(twin) ||
    isContrastWord(twin)
  );
}

/** The same text with its ellipses written the other way, for the item's spelling. */
function ellipsisSpellings(text: string): string[] {
  const spellings = [text];
  const dotted = text.replace(THREE_DOTS, '…');
  const chars = text.replace(/…/gu, '...');
  for (const variant of [dotted, chars]) {
    if (!spellings.includes(variant)) spellings.push(variant);
  }
  return spellings;
}

/**
 * The whole quotation as one run of the item, ellipses included: the way
 * a speaker's own "..." or a quotation with nothing left out is matched.
 */
function matchWhole(itemNormalized: string, inner: string): QuoteMatch | null {
  const text = normalizeForQuoteMatch(inner);
  if (!text) return null;
  const words = text.split(' ').filter((word) => WORD_CHAR.test(word)).length;
  if (words < MIN_QUOTE_WORDS) return null;
  const start = inner.length - inner.trimStart().length;
  const raw = { start, end: inner.trimEnd().length };
  for (const spelling of ellipsisSpellings(text)) {
    const found = locateFragment(
      itemNormalized,
      {
        raw,
        text: spelling,
        bare: spelling.replace(TRAILING_PUNCTUATION, ''),
        words,
      },
      0,
      true,
    );
    if (found) {
      return {
        pieces: [found],
        elided: false,
        verbatim: [raw],
        insertions: [],
      };
    }
  }
  return null;
}

/**
 * Matches a quotation's inner text against one normalized item text.
 * `insertionAllowed` says whether a bracketed word (already folded) is one
 * the item or its attribution carries; grammar words and verbs of saying
 * are always allowed.
 */
export function matchQuotation(
  itemNormalized: string,
  inner: string,
  insertionAllowed: (word: string) => boolean,
): QuoteMatch | null {
  const tokens = tokenize(inner);
  if (!tokens) return null;
  const hasInsertion = tokens.some((token) => token.kind === 'insert');
  const gapAtEdge =
    tokens[0]?.kind === 'gap' || tokens[tokens.length - 1]?.kind === 'gap';
  // The speaker's own ellipsis: the item reads the same, dots and all. A
  // gap at either edge always leaves words out, so it never matches whole.
  if (!hasInsertion && !gapAtEdge) {
    const whole = matchWhole(itemNormalized, inner);
    if (whole) return whole;
  }
  const parsed = parseTokens(inner, tokens);
  if (!parsed) return null;
  for (const insertion of parsed.insertions) {
    for (const word of insertion.words) {
      if (
        !STOP_WORDS.has(word) &&
        !SAYING_VERBS.has(word) &&
        !insertionAllowed(word)
      ) {
        return null;
      }
    }
  }
  const { fragments } = parsed;
  const last = fragments.length - 1;
  if (parsed.plain) {
    const found = locateFragment(itemNormalized, fragments[0], 0, true);
    return found
      ? {
          pieces: [found],
          elided: false,
          verbatim: [fragments[0].raw],
          insertions: [],
        }
      : null;
  }
  const first = fragments[0];
  const starts = alignedOccurrences(itemNormalized, first.text).map(
    (start) => ({ start, end: start + first.text.length }),
  );
  // The bare form only stands in for the LAST fragment.
  const firstBare = last === 0 ? first.bare : undefined;
  if (firstBare && firstBare !== first.text) {
    starts.push(
      ...alignedOccurrences(itemNormalized, firstBare).map((start) => ({
        start,
        end: start + firstBare.length,
      })),
    );
  }
  let attempts = 0;
  for (const at0 of starts) {
    attempts += 1;
    if (attempts > MAX_MATCH_ATTEMPTS) return null;
    const pieces: TextRange[] = [at0];
    let pos = at0.end;
    let ok = true;
    // Whether any gap really left words out; a gap over the speaker's own
    // "…" or over nothing keeps the quotation whole.
    let dropped = parsed.insertions.length > 0;
    for (let k = 1; k <= last; k += 1) {
      // The gap itself is checked below; the run before it is the quote's.
      const found = locateFragment(
        itemNormalized,
        fragments[k],
        pos,
        k === last,
        pos,
      );
      if (!found) {
        ok = false;
        break;
      }
      const gap = itemNormalized.slice(pos, found.start);
      if (WORD_CHAR.test(gap)) {
        // "could not … stay": a fragment ending in a negator or a scope
        // word cannot be followed by words left out, whatever they were.
        if (
          gap.length > MAX_ELISION_GAP_CHARS ||
          countWords(gap) > MAX_ELISION_GAP_WORDS ||
          gapTurnsMeaning(gap) ||
          endsInPolarityWord(fragments[k - 1].text)
        ) {
          ok = false;
          break;
        }
        dropped = true;
      }
      pieces.push(found);
      pos = found.end;
    }
    if (!ok) continue;
    if (
      parsed.leadingGap &&
      WORD_CHAR.test(itemNormalized.slice(0, at0.start))
    ) {
      // "… lost the clinic" out of "we almost lost the clinic": the words
      // before the first run are held to the same rule as an inner gap.
      if (gapTurnsMeaning(clauseBefore(itemNormalized, at0.start))) continue;
      dropped = true;
    }
    if (parsed.trailingGap && WORD_CHAR.test(itemNormalized.slice(pos))) {
      // "We could not …": the run before a trailing gap may not end in a
      // negator, and the words dropped may not open with a turn (", but").
      if (
        endsInPolarityWord(fragments[last].text) ||
        startsWithTurn(clauseAfter(itemNormalized, pos))
      ) {
        continue;
      }
      dropped = true;
    }
    return {
      pieces,
      elided: dropped,
      verbatim: fragments.map((fragment) => fragment.raw),
      insertions: parsed.insertions.map(({ start, end }) => ({
        start,
        end,
      })),
    };
  }
  return null;
}
