/**
 * Deterministic (LLM-free) detection of document length-transformation
 * requests — "trim this to 6k words", "cut it in half".
 *
 * This exists because every probabilistic trigger for this task failed in
 * practice: native-capable models ignored an attached sandbox tool, and the
 * nano router classified word-count trims as "pure text tasks". A regex has
 * zero discretion, zero latency, and is exhaustively unit-testable. Runs
 * against the RAW user prompt only — never the enriched message, whose
 * injected file excerpts would false-positive.
 */

/** A resolved length target for the trim pipeline. */
export type TrimTarget =
  | {
      kind: 'absolute';
      unit: 'words' | 'characters';
      target: number;
      /** "about"/"~"/pages-derived — widens acceptance, nothing else. */
      approx: boolean;
    }
  | {
      kind: 'ratio';
      /** Fraction of the document to KEEP (0–1, exclusive). */
      keep: number;
      approx: true;
    };

export type TrimmableFormat = 'docx' | 'md' | 'txt';

export interface TrimmableDocument {
  filename: string;
  format: TrimmableFormat;
}

/** Words-per-page heuristic for "trim to 5 pages" (double-spaced norm). */
const WORDS_PER_PAGE = 500;

/**
 * Transform verbs. Deliberately excludes "summarize"/"rewrite"/"edit" — a
 * summary or general edit is not a length transformation, and false
 * positives here would hijack ordinary turns into the trim pipeline.
 */
const VERB_RE =
  /\b(?:trim|shorten|shrink|reduce|cut(?:\s+(?:it|this|that|the\s+\w+))?(?:\s+down)?|condense|compress|abridge|halve|(?:bring|get)\s+(?:it|this|that)\s+(?:down\s+)?(?:to|under|below)|make\s+(?:it|this|that)\s+(?:shorter|under))\b/i;

/**
 * Absolute target: a number (1,234 / 1234 / 6.5) with an optional thousands
 * suffix (k / thousand), followed by a unit. The unit is REQUIRED — a bare
 * number ("make it under 6000") is too ambiguous to hijack the turn on.
 */
const ABSOLUTE_RE =
  /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b|thousand\b)?\s*[- ]?\s*(words?|characters?|chars?|pages?)\b/i;

const APPROX_RE = /\b(?:about|around|roughly|approximately|approx\.?)\b|~/i;

/** Ratio phrasings → fraction of the document to KEEP. */
const RATIO_PATTERNS: Array<{
  re: RegExp;
  keep: (m: RegExpMatchArray) => number;
}> = [
  // "cut it in half", "halve it", "reduce by half", "cut it down by half"
  { re: /\b(?:in|by)\s+half\b|\bhalve\b/i, keep: () => 0.5 },
  // "half as long", "make it half the length"
  { re: /\bhalf\s+(?:as\s+long|the\s+(?:length|size))\b/i, keep: () => 0.5 },
  // "reduce TO a third/quarter" — keep that fraction
  { re: /\bto\s+(?:a\s+|one[- ])?third\b/i, keep: () => 1 / 3 },
  { re: /\bto\s+(?:a\s+|one[- ])?quarter\b/i, keep: () => 0.25 },
  // "reduce BY a third/quarter" — remove that fraction
  { re: /\bby\s+(?:a\s+|one[- ])?third\b/i, keep: () => 2 / 3 },
  { re: /\bby\s+(?:a\s+|one[- ])?quarter\b/i, keep: () => 0.75 },
  // "cut by 30%" — remove that share; "shorten to 75%" — keep that share.
  // No \b after "%": percent signs are non-word chars, so a boundary there
  // can never match.
  {
    re: /\bby\s+(\d{1,2})\s*(?:%|percent\b)/i,
    keep: (m) => 1 - Number(m[1]) / 100,
  },
  {
    re: /\bto\s+(\d{1,2})\s*(?:%|percent\b)/i,
    keep: (m) => Number(m[1]) / 100,
  },
];

/**
 * Detects a length-transformation request in the raw user prompt.
 * Returns null when no transform verb + target conjunction is present —
 * those turns keep today's routing (router fallback) untouched.
 */
export function detectTrimRequest(rawUserPrompt: string): TrimTarget | null {
  if (!rawUserPrompt || !VERB_RE.test(rawUserPrompt)) return null;

  const approx = APPROX_RE.test(rawUserPrompt);

  const absolute = rawUserPrompt.match(ABSOLUTE_RE);
  if (absolute) {
    const rawNumber = Number(absolute[1].replace(/,/g, ''));
    if (Number.isFinite(rawNumber) && rawNumber > 0) {
      const scaled = absolute[2] ? rawNumber * 1000 : rawNumber;
      const unitWord = absolute[3].toLowerCase();
      if (unitWord.startsWith('page')) {
        return {
          kind: 'absolute',
          unit: 'words',
          target: Math.round(scaled * WORDS_PER_PAGE),
          approx: true,
        };
      }
      return {
        kind: 'absolute',
        unit: unitWord.startsWith('word') ? 'words' : 'characters',
        target: Math.round(scaled),
        approx,
      };
    }
  }

  for (const { re, keep } of RATIO_PATTERNS) {
    const match = rawUserPrompt.match(re);
    if (match) {
      const fraction = keep(match);
      if (fraction > 0 && fraction < 1) {
        return { kind: 'ratio', keep: fraction, approx: true };
      }
    }
  }

  return null;
}

const FORMAT_BY_EXTENSION: Record<string, TrimmableFormat> = {
  docx: 'docx',
  md: 'md',
  markdown: 'md',
  txt: 'txt',
};

/**
 * Picks the document the trim applies to from the attachment manifest.
 * Current-turn attachments win over prior-turn ones; within a turn, first
 * eligible file wins. Non-trimmable formats (PDF, XLSX, …) return null so
 * the turn falls through to normal routing instead of a doomed pipeline.
 */
export function pickTrimmableDocument(manifest: {
  currentTurn: string[];
  priorTurns: string[];
}): TrimmableDocument | null {
  for (const filename of [...manifest.currentTurn, ...manifest.priorTurns]) {
    const extension = filename.split('.').pop()?.toLowerCase() ?? '';
    const format = FORMAT_BY_EXTENSION[extension];
    if (format) return { filename, format };
  }
  return null;
}
