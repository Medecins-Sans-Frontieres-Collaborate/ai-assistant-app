/**
 * Grounding: which spans of a version trace to the brief, and which do not.
 *
 * Pure string work, no model. Marks are recomputed on every change and never
 * stored, because stored offsets rot on the first keystroke. A quoted string
 * or a number that matches nothing in the brief is the finding that catches
 * a fabricated quote or statistic.
 */
import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';

import { Brief, BriefItem, GroundingMark, Segment } from '@/types/drafter';

import { TextRange, isWordAligned } from './verify';

/** Below this many words a quoted string is a label, not a quotation. */
const MIN_QUOTE_WORDS = 3;

/** `itemId` of a mark grounded in the key message or the call to action. */
export const BRIEF_ITSELF = '__brief__';

/**
 * Quotation marks by family. Within a family any closer ends any opener,
 * because people mix them: an ASCII " closed by a curly one, a German low
 * opener closed by an ASCII mark.
 */
type QuoteFamily =
  | 'double'
  | 'angle'
  | 'angleReversed'
  | 'single'
  | 'singleAngle'
  | 'singleAngleReversed'
  | 'corner'
  | 'whiteCorner';

/**
 * Families whose marks mean nothing but quotation, so an opener with no
 * closer (or a closer with no opener) is still a claim that someone said
 * something. Single marks are left out: they are also apostrophes.
 */
const UNAMBIGUOUS_FAMILIES: ReadonlySet<QuoteFamily> = new Set<QuoteFamily>([
  'double',
  'angle',
  'angleReversed',
]);

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const WHITESPACE = /\s/u;

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

/** Starts a word: `”Vi gick` opens, `dagar” sa hon` does not. */
function opensWord(text: string, index: number): boolean {
  return (
    !isLetterOrNumber(text[index - 1]) && isLetterOrNumber(text[index + 1])
  );
}

/**
 * The family `text[index]` opens, if it opens one. Marks that double as
 * something else must look like an opener: an apostrophe only after a
 * non-letter and before a letter (never "don't", "MSF's", "nurses'"), and an
 * ASCII " never straight after a digit (an inch mark).
 */
function openerFamily(text: string, index: number): QuoteFamily | null {
  switch (text[index]) {
    case '“':
    case '„':
      return 'double';
    case '"':
      return isDigit(text[index - 1]) ? null : 'double';
    case '”':
      // Swedish and Finnish open with the same mark they close with.
      return opensWord(text, index) ? 'double' : null;
    case '«':
      return 'angle';
    case '»':
      return opensWord(text, index) ? 'angleReversed' : null;
    case '‹':
      return 'singleAngle';
    case '›':
      return opensWord(text, index) ? 'singleAngleReversed' : null;
    case '‘':
      return !isLetterOrNumber(text[index - 1]) && !isSpace(text[index + 1])
        ? 'single'
        : null;
    case '‚':
    case "'":
      return !isLetterOrNumber(text[index - 1]) && isLetter(text[index + 1])
        ? 'single'
        : null;
    case '「':
      return 'corner';
    case '『':
      return 'whiteCorner';
    default:
      return null;
  }
}

function closesFamily(
  family: QuoteFamily,
  text: string,
  index: number,
): boolean {
  const char = text[index];
  switch (family) {
    case 'double':
      if (char === '"' || char === '”') return true;
      // The German closer is the English opener; tell them apart by shape.
      return char === '“' && index > 0 && !isSpace(text[index - 1]);
    case 'angle':
      return char === '»';
    case 'angleReversed':
      return char === '«';
    case 'singleAngle':
      return char === '›';
    case 'singleAngleReversed':
      return char === '‹';
    case 'single':
      // Not an apostrophe: it ends a word and no letter follows it.
      return (
        (char === '’' || char === "'" || char === '‘') &&
        index > 0 &&
        !isSpace(text[index - 1]) &&
        !isLetterOrNumber(text[index + 1])
      );
    case 'corner':
      return char === '」';
    case 'whiteCorner':
      return char === '』';
  }
}

/** A double-family closer that nothing opened. Never an inch mark. */
function isStrayCloser(text: string, index: number): boolean {
  const char = text[index];
  if (char === '»') return true;
  return (char === '”' || char === '"') && !isDigit(text[index - 1]);
}

/** Whitespace-separated words in `text[from, to)`, counted up to `max`. */
function countWords(
  text: string,
  from: number,
  to: number,
  max: number,
): number {
  let count = 0;
  let inWord = false;
  for (let i = from; i < to && count < max; i += 1) {
    const space = isSpace(text[i]);
    if (!space && !inWord) count += 1;
    inWord = !space;
  }
  return count;
}

export interface QuotedSpan extends TextRange {
  inner: string;
  /**
   * The quotation has only one of its marks in this text (a quote split
   * across two posts). It is checked for verbatim like any other.
   */
  unbalanced?: true;
}

/**
 * Quoted strings long enough to be a claim that someone said something.
 *
 * One pass, with the next closer of each family precomputed, so a hostile
 * run of openers stays linear. An opener of an unambiguous family with no
 * closer claims everything to the end of the text, and a closer with no
 * opener everything before it: a quotation split across two posts must not
 * pass unchecked just because each half has one mark.
 */
export function findQuotedSpans(text: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  const nextCloser = new Map<QuoteFamily, Int32Array>();
  const closerFrom = (family: QuoteFamily, from: number): number => {
    let table = nextCloser.get(family);
    if (!table) {
      table = new Int32Array(text.length + 1).fill(-1);
      for (let j = text.length - 1; j >= 0; j -= 1) {
        table[j] = closesFamily(family, text, j) ? j : table[j + 1];
      }
      nextCloser.set(family, table);
    }
    return table[Math.min(from, text.length)];
  };

  let index = 0;
  /** End of the last closed quotation: where a stray closer's claim starts. */
  let consumed = 0;
  while (index < text.length) {
    const family = openerFamily(text, index);
    if (family) {
      const close = closerFrom(family, index + 1);
      if (close >= 0) {
        if (
          countWords(text, index + 1, close, MIN_QUOTE_WORDS) >= MIN_QUOTE_WORDS
        ) {
          spans.push({
            start: index + 1,
            end: close,
            inner: text.slice(index + 1, close),
          });
        }
        index = close + 1;
        consumed = index;
        continue;
      }
      const unclosed =
        UNAMBIGUOUS_FAMILIES.has(family) &&
        // A lone ASCII " at the end of a word is a closer, handled below.
        (text[index] !== '"' || opensWord(text, index)) &&
        countWords(text, index + 1, text.length, MIN_QUOTE_WORDS) >=
          MIN_QUOTE_WORDS;
      if (unclosed) {
        const end = text.trimEnd().length;
        spans.push({
          start: index + 1,
          end,
          inner: text.slice(index + 1, end),
          unbalanced: true,
        });
        break;
      }
      if (text[index] !== '"') {
        index += 1;
        continue;
      }
    }
    if (isStrayCloser(text, index)) {
      let start = consumed;
      while (start < index && isSpace(text[start])) start += 1;
      if (countWords(text, start, index, MIN_QUOTE_WORDS) >= MIN_QUOTE_WORDS) {
        spans.push({
          start,
          end: index,
          inner: text.slice(start, index),
          unbalanced: true,
        });
      }
      consumed = index + 1;
    }
    index += 1;
  }
  return spans;
}

const URL_OR_TAG_PATTERN = /(?:https?:\/\/|www\.)\S+|[#@][\p{L}\p{N}_]+/giu;

/**
 * A written number. A space, comma, period or apostrophe groups thousands
 * only when exactly three digits follow a group of at most three, so
 * "In 2024, 500 came" and "2024. 12 clinics" are two numbers each; a decimal
 * separator must be directly followed by digits. The first alternative is
 * Indian grouping ("12,34,567").
 */
const NUMBER_PATTERN =
  /(?<!\p{Nd})(?:\p{Nd}{1,2}(?:,\p{Nd}{2})+,\p{Nd}{3}(?!\p{Nd})|\p{Nd}{1,3}(?:[.,\u00A0\u202F\u066C'’ ]\p{Nd}{3}(?!\p{Nd}))+|\p{Nd}+)(?:[.,\u066B]\p{Nd}+)?/gu;

/**
 * The magnitude or percent sign after a number, which is part of the number:
 * "8 million" is not "8", and not "8 billion". Spelled-out words may follow
 * a space; one-letter abbreviations only count attached ("5m", not "5 m",
 * which is metres). Long-scale words ("billón", "Billionen") are 10^12;
 * a bare "billion" is read as English.
 */
const UNIT_PATTERN =
  /[ \u00A0\u202F]?(?:(?<percent>[%\u066A]|(?:per ?cent|pour ?cent|por ciento|por cento|prozent|per cento|pct)(?![\p{L}\p{N}]))|(?:(?<e9>mil[ \u00A0]millones|mil[ \u00A0]milh[õo]es|billions?|bn|milliards?|milliarden?|mrd|bilh(?:ão|ões)|miliard[oi])|(?<e12>trillions?|billón|billones|billionen)|(?<e6>millions?|millionen|mio|millón|millones|milh(?:ão|ões)|milion[ei])|(?<e3>thousand|mille|mila|mil|tausend))(?![\p{L}\p{N}]))/iuy;
const ATTACHED_UNIT_PATTERN = /(?:(?<e3>k)|(?<e6>m))(?![\p{L}\p{N}])/iuy;

interface NumberUnit {
  length: number;
  percent: boolean;
  exponent: number;
}

function unitAt(text: string, index: number): NumberUnit | null {
  for (const pattern of [UNIT_PATTERN, ATTACHED_UNIT_PATTERN]) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    const groups = match?.groups;
    if (!match || !groups) continue;
    let exponent = 0;
    if (groups.e3) exponent = 3;
    else if (groups.e6) exponent = 6;
    else if (groups.e9) exponent = 9;
    else if (groups.e12) exponent = 12;
    return { length: match[0].length, percent: !!groups.percent, exponent };
  }
  return null;
}

/** The longest run of decimal digits in Unicode (the mathematical sets). */
const LONGEST_DIGIT_RUN = 50;

/**
 * Value of any Unicode decimal digit. Every script's digits are ten
 * consecutive code points from zero up, and where sets sit back to back the
 * run is a multiple of ten, so the distance to the start of the run gives
 * the value without a table of scripts.
 */
function digitValue(codePoint: number): number {
  let runStart = codePoint;
  while (
    codePoint - runStart < LONGEST_DIGIT_RUN &&
    runStart > 0 &&
    DIGIT.test(String.fromCodePoint(runStart - 1))
  ) {
    runStart -= 1;
  }
  return (codePoint - runStart) % 10;
}

/**
 * Arabic-Indic, Persian, Devanagari… digits as ASCII, so a brief translated
 * into another script still proves the same numbers.
 */
function foldDigits(raw: string): string {
  let folded = '';
  for (const char of raw) {
    if (char === '\u066B') folded += '.';
    else if (char === '\u066C') folded += ',';
    else if (char >= '0' && char <= '9') folded += char;
    else if (DIGIT.test(char)) folded += digitValue(char.codePointAt(0) ?? 0);
    else folded += char;
  }
  return folded;
}

/** `digits` times ten to the `exponent`, on the written digits (no floats). */
function scaleDigits(digits: string, exponent: number): string {
  const [whole, fraction = ''] = digits.split('.');
  const padded = fraction.padEnd(exponent, '0');
  const integer = `${whole}${padded.slice(0, exponent)}`.replace(
    /^0+(?=[0-9])/u,
    '',
  );
  const rest = padded.slice(exponent).replace(/0+$/u, '');
  return rest ? `${integer}.${rest}` : integer;
}

/**
 * Canonical form of a written number, so "1,200", "1 200" and "1.200" agree
 * while "1.5" and "15" do not. A final group of exactly three digits after a
 * separator is read as thousands; any other final group as decimals. A
 * magnitude is multiplied in ("8 million" is "8000000", which "8 billion"
 * is not) and every way of writing percent ends in "%".
 */
export function canonicalNumber(raw: string): string {
  const folded = foldDigits(raw).trim();
  const numeric = /^[0-9.,\u00A0\u202F'’ ]*[0-9]/u.exec(folded)?.[0] ?? '';
  const unit = unitAt(folded, numeric.length);
  const groups = numeric.split(/[.,\u00A0\u202F'’ ]+/u).filter(Boolean);
  let digits = groups[0] ?? '';
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    digits =
      last.length === 3
        ? groups.join('')
        : `${groups.slice(0, -1).join('')}.${last}`;
  }
  if (unit?.exponent) digits = scaleDigits(digits, unit.exponent);
  return `${digits}${unit?.percent ? '%' : ''}`;
}

export interface NumberSpan extends TextRange {
  canonical: string;
}

/** Numbers that state a fact. Links, hashtags and handles are skipped. */
export function findNumbers(text: string): NumberSpan[] {
  const skip: TextRange[] = [];
  for (const match of text.matchAll(URL_OR_TAG_PATTERN)) {
    const start = match.index ?? 0;
    skip.push({ start, end: start + match[0].length });
  }
  const spans: NumberSpan[] = [];
  let nextSkip = 0;
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const start = match.index ?? 0;
    // Both lists are in text order, so the skip ranges are walked once.
    while (nextSkip < skip.length && skip[nextSkip].end <= start) {
      nextSkip += 1;
    }
    if (nextSkip < skip.length && start >= skip[nextSkip].start) continue;
    const unit = unitAt(text, start + match[0].length);
    const end = start + match[0].length + (unit?.length ?? 0);
    const canonical = canonicalNumber(text.slice(start, end));
    // A bare single digit ("3 things") is prose, not a statistic. With a
    // magnitude or a percent sign ("3 million", "5%") it is one.
    if (/^[0-9]$/u.test(canonical)) continue;
    spans.push({ start, end, canonical });
  }
  return spans;
}

/** Every number `text` states is written in `evidence`. */
export function numbersSupported(text: string, evidence: string): boolean {
  const proven = new Set(findNumbers(evidence).map((n) => n.canonical));
  return findNumbers(text).every((n) => proven.has(n.canonical));
}

const NAME_PATTERN =
  /\p{Lu}[\p{L}\p{M}'’-]*(?:\s+(?:\p{Lu}[\p{L}\p{M}'’-]*|de|del|van|von|bin|al|el))*\s+\p{Lu}[\p{L}\p{M}'’-]*/gu;

/**
 * Capitalised only because they start the sentence, even when a capitalised
 * word follows ("The Clinic", "Yesterday Amina Yusuf", "Meet Amina"). Any
 * other first word is kept, since it may be a first name.
 */
const SENTENCE_OPENERS: ReadonlySet<string> = new Set(
  (
    'the a an this that these those our my his her their its we in on at ' +
    'from for with after before when while since but and yesterday today ' +
    'tomorrow meet read donate learn help join watch support share thank ' +
    'le la les un une des ce cette ces notre nos dans en pour avec hier ' +
    'el los las una este esta nuestro nuestra para con ayer hoy ' +
    'der die das ein eine dieser diese dieses unser unsere im am für mit ' +
    'gestern heute ' +
    'o os as um uma nosso nossa em no na com ontem hoje ' +
    'il lo i gli uno questo questa nostro nostra per ieri oggi'
  ).split(' '),
);

const OPENING_MARKS = '"“„«‘‚‹';
const SENTENCE_ENDS = '.!?…:';

/** Scans backwards by hand: a `…\s*$` regex on a long prefix is quadratic. */
function startsSentence(text: string, start: number): boolean {
  let i = start - 1;
  let sawNewline = false;
  while (i >= 0 && isSpace(text[i])) {
    if (text[i] === '\n') sawNewline = true;
    i -= 1;
  }
  if (i < 0 || sawNewline) return true;
  if (OPENING_MARKS.includes(text[i])) return true;
  return i < start - 1 && SENTENCE_ENDS.includes(text[i]);
}

function wordsOf(text: string): string[] {
  return normalizeForQuoteMatch(text)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

/** The words of a name that must be found; particles and initials are not. */
function nameWords(name: string): string[] {
  const words = wordsOf(name);
  const long = words.filter((word) => word.length > 2);
  // "Li Na" has no long word, and must not pass for having nothing to check.
  return long.length > 0 ? long : words.filter((word) => word.length > 1);
}

export interface NameSpan extends TextRange {
  name: string;
  /**
   * Set when the name starts a sentence and has three or more words: the
   * first may be an ordinary word ("Nurse Amina Yusuf"), so the name also
   * counts as grounded when the words after it are.
   */
  withoutFirstWord?: string;
}

/**
 * Capitalised multi-word names (a person, a place, an organisation). A word
 * that merely starts a sentence is dropped from the front when it stands
 * alone or is a function word, so "The Clinic" is not a name; followed by
 * another capitalised word it is kept, so "Robert Mugabe said…" is checked
 * at the start of a post as it is in the middle. Scripts without letter case
 * yield nothing, which is the honest answer: the heuristic does not apply
 * there.
 */
export function findNames(text: string): NameSpan[] {
  const names: NameSpan[] = [];
  for (const match of text.matchAll(NAME_PATTERN)) {
    let start = match.index ?? 0;
    let name = match[0];
    let withoutFirstWord: string | undefined;
    if (startsSentence(text, start)) {
      const rest = name.replace(/^\S+\s+/u, '');
      const first = name.slice(0, name.length - rest.length).trim();
      if (SENTENCE_OPENERS.has(first.toLowerCase())) {
        start += name.length - rest.length;
        name = rest;
      } else if (rest.split(/\s+/u).length >= 2) {
        withoutFirstWord = rest;
      }
    }
    if (name.trim().split(/\s+/u).length < 2) continue;
    names.push({
      start,
      end: start + name.length,
      name,
      ...(withoutFirstWord ? { withoutFirstWord } : {}),
    });
  }
  return names;
}

/**
 * Names in the segments whose words do not all appear together in ONE brief
 * item (its text or attribution), the key message or the call to action.
 * Together, because a bag of words over the whole brief lets "Amina Smith"
 * pass on "Amina Yusuf" and "John Smith". A warning, not a block: the
 * heuristic cannot tell a person from a place, only that the brief never
 * mentions it.
 */
export function ungroundedNames(
  segments: Segment[],
  brief: Brief,
): Array<NameSpan & { segmentId: string }> {
  const entries = briefTexts(brief).map(
    (entry) => new Set(wordsOf(entry.text)),
  );
  const known = (name: string): boolean => {
    const words = nameWords(name);
    return entries.some((entry) => words.every((word) => entry.has(word)));
  };
  return segments.flatMap((segment) =>
    findNames(segment.text)
      .filter(
        (found) =>
          !known(found.name) &&
          !(found.withoutFirstWord && known(found.withoutFirstWord)),
      )
      .map((found) => ({ ...found, segmentId: segment.id })),
  );
}

function includedItems(brief: Brief): BriefItem[] {
  return brief.items.filter((item) => item.decision === 'included');
}

/** Every text of the brief a version may legitimately restate. */
function briefTexts(brief: Brief): Array<{ itemId?: string; text: string }> {
  return [
    ...includedItems(brief).map((item) => ({
      itemId: item.id,
      text: item.attribution
        ? `${item.text} ${item.attribution.name} ${item.attribution.role ?? ''}`
        : item.text,
    })),
    { text: brief.keyMessage },
    { text: brief.callToAction ?? '' },
  ];
}

/**
 * Words that turn the meaning of what follows. A partial quotation that
 * starts right after one ("have enough water" out of "did not have enough
 * water") is verbatim and says the opposite.
 */
const NEGATORS: ReadonlySet<string> = new Set(
  (
    'not no never without nor cannot neither ' +
    'ne pas jamais sans ni aucun aucune ' +
    'nunca sin jamás ' +
    'nicht kein keine keinen keinem keiner keines nie niemals ohne ' +
    'não sem nem ' +
    'non mai senza né'
  ).split(' '),
);

const NAME_WORD_CHAR = /[\p{L}\p{M}\p{N}']/u;

/** The word just before `at` negates, within the same sentence. */
function negatedBefore(text: string, at: number): boolean {
  let end = at;
  while (end > 0 && !NAME_WORD_CHAR.test(text[end - 1])) {
    if (SENTENCE_ENDS.includes(text[end - 1]) || text[end - 1] === ';') {
      return false;
    }
    end -= 1;
  }
  let start = end;
  while (start > 0 && NAME_WORD_CHAR.test(text[start - 1])) start -= 1;
  const word = text.slice(start, end).replace(/^'+|'+$/gu, '');
  return NEGATORS.has(word) || word.endsWith("n't");
}

/**
 * `needle` is in `haystack` on word boundaries ("id not have enough wat" is
 * not a quotation) and not as the tail of a negation. Both are normalized.
 */
function quotedVerbatim(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (
      isWordAligned(haystack, at, at + needle.length, true) &&
      !negatedBefore(haystack, at)
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * What a quotation in a version may be matched against: the words of a
 * quote or testimony, and for any other kind only a quotation the item
 * itself carries inside quotation marks. A fact's own wording was never
 * said by anyone, so putting it in quotation marks invents a speaker.
 */
function quotableTexts(item: BriefItem): string[] {
  if (item.kind === 'quote' || item.kind === 'testimony') {
    return [normalizeForQuoteMatch(item.text)];
  }
  return findQuotedSpans(item.text)
    .filter((span) => !span.unbalanced)
    .map((span) => normalizeForQuoteMatch(span.inner));
}

/**
 * Marks for one segment. A mark without `itemId` that is a quote, or a
 * number found nowhere in the brief, is ungrounded.
 */
export function groundSegment(segment: Segment, brief: Brief): GroundingMark[] {
  const marks: GroundingMark[] = [];
  const quotable = includedItems(brief).map((item) => ({
    id: item.id,
    texts: quotableTexts(item),
  }));

  const quotes = findQuotedSpans(segment.text);
  for (const quote of quotes) {
    const needle = normalizeForQuoteMatch(quote.inner);
    // A post may end a quotation with a full stop the brief item lacks.
    const bare = needle.replace(/[\s.,;:!?…]+$/u, '');
    // A partial quotation of a verified quote is still verbatim.
    const hit = quotable.find((item) =>
      item.texts.some(
        (text) => quotedVerbatim(text, needle) || quotedVerbatim(text, bare),
      ),
    );
    marks.push({
      segmentId: segment.id,
      start: quote.start,
      end: quote.end,
      kind: 'quote',
      itemId: hit?.id,
    });
  }

  const sources = briefTexts(brief).map((entry) => ({
    itemId: entry.itemId,
    numbers: new Set(findNumbers(entry.text).map((n) => n.canonical)),
  }));
  for (const number of findNumbers(segment.text)) {
    // A number inside a matched quotation is already proven by the quote.
    const insideQuote = marks.some(
      (mark) =>
        mark.kind === 'quote' &&
        mark.itemId &&
        number.start >= mark.start &&
        number.end <= mark.end,
    );
    if (insideQuote) continue;
    const hit = sources.find((entry) => entry.numbers.has(number.canonical));
    marks.push({
      segmentId: segment.id,
      start: number.start,
      end: number.end,
      kind: 'number',
      // Found in the key message or call to action: grounded, no item.
      itemId: hit?.itemId ?? (hit ? BRIEF_ITSELF : undefined),
    });
  }
  return marks.sort((a, b) => a.start - b.start);
}

export function isGrounded(mark: GroundingMark): boolean {
  return mark.itemId !== undefined;
}

export function groundVersion(
  segments: Segment[],
  brief: Brief,
): GroundingMark[] {
  return segments.flatMap((segment) => groundSegment(segment, brief));
}

/** "6 of 6 traced to a source", split by how each item was verified. */
export interface ProofSummary {
  total: number;
  traced: number;
  vouched: number;
  ungrounded: number;
}

export function summarizeProof(
  marks: GroundingMark[],
  brief: Brief,
): ProofSummary {
  const byId = new Map(brief.items.map((item) => [item.id, item]));
  const summary: ProofSummary = {
    total: marks.length,
    traced: 0,
    vouched: 0,
    ungrounded: 0,
  };
  for (const mark of marks) {
    if (!mark.itemId) {
      summary.ungrounded += 1;
      continue;
    }
    const item = byId.get(mark.itemId);
    if (item?.verified === 'user-asserted') summary.vouched += 1;
    else summary.traced += 1;
  }
  return summary;
}

/** Which specs' versions draw on a brief item ("Used in LinkedIn, X"). */
export function specsUsingItem(
  itemId: string,
  versions: Record<string, { segments: Segment[] }>,
  brief: Brief,
): string[] {
  return Object.entries(versions)
    .filter(([, version]) =>
      version.segments.some(
        (segment) =>
          segment.usedItemIds.includes(itemId) ||
          groundSegment(segment, brief).some((mark) => mark.itemId === itemId),
      ),
    )
    .map(([specId]) => specId);
}
