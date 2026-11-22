/**
 * Repair of text a model returned with a broken character escape.
 *
 * In structured (JSON) output a model occasionally writes a character's
 * escape with two digits too many: `\u0000e9` for `é` ("é"). Parsed,
 * that is a NUL character followed by the two hex digits that were meant
 * to finish the escape. Less often the character is lost outright and only
 * the NUL remains (seen for a typographic apostrophe). A NUL is never
 * meant, and left in place it cuts the text off wherever it is drawn.
 *
 * The convention, stated once here: a NUL marks one lost character.
 *   1. NUL + two hex digits naming a Latin-1 letter or sign (U+00A0 to
 *      U+00FF) is that character, unless rule 2 claims it.
 *   2. NUL right after a one-letter word and before two letters is an
 *      elision apostrophe ("l'adresse"): there the two letters can look
 *      like hex digits ("ad") without being any. A pair with a digit in it
 *      ("e9") starts no word, so rule 1 keeps it ("s" + "e9" + "curiser").
 *   3. Any other NUL between two letters is an apostrophe.
 *   4. Any NUL left is removed.
 */

const NUL = '\u0000';
const APOSTROPHE = '’';
/** First character a two-digit escape can sensibly name (no-break space). */
const FIRST_LATIN1_PRINTABLE = 0xa0;

const LETTER = /\p{L}/u;
const HEX_PAIR = /^[0-9a-fA-F]{2}$/;
const TWO_LETTERS = /^\p{L}{2}$/u;

/** Whether the NUL at `index` follows a word of exactly one letter. */
function followsOneLetterWord(text: string, index: number): boolean {
  const before = text[index - 1] ?? '';
  const earlier = text[index - 2] ?? '';
  return LETTER.test(before) && !LETTER.test(earlier);
}

/**
 * Whether a value holds a NUL character anywhere in its strings.
 *
 * @param value - Any parsed JSON value.
 * @returns True when some string in it contains a NUL.
 */
export function hasBrokenEscape(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasBrokenEscape);
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasBrokenEscape);
  }
  return false;
}

/**
 * Puts back the characters a broken escape lost, by the rules at the top
 * of this file. Text without a NUL is returned unchanged.
 *
 * @param text - Text as parsed from a model's JSON.
 * @returns The text with no NUL characters.
 * @example repairBrokenEscapes('ru\u0000e9e') // 'ruée'
 */
export function repairBrokenEscapes(text: string): string {
  if (!text.includes(NUL)) return text;
  let repaired = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== NUL) {
      repaired += text[index];
      continue;
    }
    const pair = text.slice(index + 1, index + 3);
    const next = text[index + 1] ?? '';
    const elision = followsOneLetterWord(text, index) && TWO_LETTERS.test(pair);
    const code = HEX_PAIR.test(pair) ? parseInt(pair, 16) : -1;
    if (!elision && code >= FIRST_LATIN1_PRINTABLE) {
      repaired += String.fromCharCode(code);
      index += 2;
    } else if (LETTER.test(text[index - 1] ?? '') && LETTER.test(next)) {
      repaired += APOSTROPHE;
    }
  }
  return repaired;
}

/**
 * {@link repairBrokenEscapes} applied to every string inside a parsed JSON
 * value. Keys are left as they are.
 *
 * @param value - Any parsed JSON value.
 * @returns A value of the same shape with repaired strings.
 */
export function repairBrokenEscapesDeep<T>(value: T): T {
  if (typeof value === 'string') return repairBrokenEscapes(value) as T;
  if (Array.isArray(value)) return value.map(repairBrokenEscapesDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        repairBrokenEscapesDeep(inner),
      ]),
    ) as T;
  }
  return value;
}
