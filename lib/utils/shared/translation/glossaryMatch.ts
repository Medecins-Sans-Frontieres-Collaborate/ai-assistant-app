import {
  GlossaryEntry,
  GlossaryEntryKind,
  GlossaryViolation,
  TranslationGlossaryCheck,
} from '@/types/workflow';

/**
 * Glossary term matching and compliance checking (issue #131).
 *
 * Shared by the prompt builder (which entries to inject and in what
 * order), the orchestrator (does the translation actually contain the
 * required terms?), and the editor (auto-detecting acronyms). One matcher
 * so the model is told the same rule the checker later applies.
 *
 * Rules:
 * - Plain terms match case-insensitively on whole words, so "Cholera"
 *   matches an entry "cholera" but "category" never matches "cat".
 * - Acronyms match the short form case-sensitively on whole words, so
 *   "the WHO issued" matches "WHO" and "Davis, who is…" does not. An
 *   acronym entry also counts as present when its full name occurs
 *   (case-insensitively).
 * - An acronym occurrence inside a SHOUTING line (an all-caps heading such
 *   as "WHO IS ELIGIBLE") is ignored: it is a word in caps, not an initialism.
 * - Word boundaries are Unicode-aware: letters and digits on either side
 *   break a match, everything else (space, punctuation, apostrophe, hyphen)
 *   is a boundary, so "l'OMS" matches "OMS" and accented terms work.
 */

/** Hard caps so a hostile entry cannot blow up the regex or the prompt. */
export const MAX_GLOSSARY_TERM_CHARS = 200;
export const MAX_GLOSSARY_NOTE_CHARS = 500;

const ACRONYM_MIN = 2;
const ACRONYM_MAX = 8;

/**
 * "Looks like an initialism": 2–8 characters of uppercase letters, digits,
 * dots, hyphens or ampersands, with at least two uppercase letters. Covers
 * WHO, MSF, H5N1, U.N., MSF-OCA, COVID-19; rejects "A", "Mr", "iPhone" and
 * anything longer than 8 characters — set `kind: 'acronym'` explicitly
 * for those.
 */
export function isAcronymLike(term: string): boolean {
  const t = term.trim();
  if (t.length < ACRONYM_MIN || t.length > ACRONYM_MAX) return false;
  if (!/^[\p{Lu}\p{N}.&-]+$/u.test(t)) return false;
  const upper = t.match(/\p{Lu}/gu);
  return !!upper && upper.length >= 2;
}

/** The entry's effective kind: explicit when set, otherwise by shape. */
export function resolveEntryKind(entry: GlossaryEntry): GlossaryEntryKind {
  if (entry.kind === 'term' || entry.kind === 'acronym') return entry.kind;
  return isAcronymLike(entry.source) ? 'acronym' : 'term';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word pattern for a term. Internal whitespace matches any run of
 * whitespace (a glossary phrase must still match across a line wrap).
 * Lookbehind/lookahead on letters and digits rather than `\b`, which is
 * ASCII-only and would put a boundary inside "hôpital".
 */
export function buildTermPattern(
  term: string,
  caseSensitive: boolean,
): RegExp | null {
  const normalized = term.trim().slice(0, MAX_GLOSSARY_TERM_CHARS);
  if (!normalized) return null;
  const body = normalized.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
    caseSensitive ? 'gu' : 'giu',
  );
}

/**
 * A line whose letters are all uppercase and which has at least three
 * words is "shouting" (a heading, a banner). An acronym match inside one
 * carries no signal that the writer meant the initialism.
 */
function isShoutingLine(line: string): boolean {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const letters = line.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return false;
  return letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase());
}

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const endIdx = text.indexOf('\n', index);
  return text.slice(start, endIdx === -1 ? text.length : endIdx);
}

/**
 * Does `term` occur in `text` as a whole word? For case-sensitive
 * (acronym) matches, occurrences inside shouting lines do not count.
 */
export function termOccursIn(
  text: string,
  term: string,
  options: { caseSensitive: boolean },
): boolean {
  const pattern = buildTermPattern(term, options.caseSensitive);
  if (!pattern) return false;
  if (!options.caseSensitive) return pattern.test(text);
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (!isShoutingLine(lineAround(text, match.index))) return true;
  }
  return false;
}

export interface MatchedGlossaryEntry {
  entry: GlossaryEntry;
  kind: GlossaryEntryKind;
  matchedBy: 'source' | 'expansion';
}

/**
 * The entries that occur in `sourceText`, in the ORIGINAL entry order (the
 * caller decides how to rank them — admin guides rank by position when a
 * budget truncates). Incomplete entries are dropped.
 */
export function findMatchingEntries(
  entries: GlossaryEntry[],
  sourceText: string,
): MatchedGlossaryEntry[] {
  const matched: MatchedGlossaryEntry[] = [];
  for (const entry of entries) {
    if (!entry || !entry.source?.trim() || !entry.target?.trim()) continue;
    const kind = resolveEntryKind(entry);
    if (kind === 'acronym') {
      if (termOccursIn(sourceText, entry.source, { caseSensitive: true })) {
        matched.push({ entry, kind, matchedBy: 'source' });
      } else if (
        entry.sourceExpansion?.trim() &&
        termOccursIn(sourceText, entry.sourceExpansion, {
          caseSensitive: false,
        })
      ) {
        matched.push({ entry, kind, matchedBy: 'expansion' });
      }
    } else if (
      termOccursIn(sourceText, entry.source, { caseSensitive: false })
    ) {
      matched.push({ entry, kind, matchedBy: 'source' });
    }
  }
  return matched;
}

/**
 * Longest source phrase first (stable), so where entries overlap
 * ("health promotion" vs "health") the model reads the specific one
 * before the general one — and the prompt tells it that order is the rule.
 */
export function sortLongestFirst<T extends { entry: GlossaryEntry }>(
  matched: T[],
): T[] {
  return [...matched].sort(
    (a, b) => b.entry.source.trim().length - a.entry.source.trim().length,
  );
}

/**
 * Deterministic compliance check: every entry present in the source must
 * have its required translation in the output. Acronym short forms are
 * checked case-sensitively (the whole point of the entry), everything
 * else case-insensitively; an acronym's full-name translation also
 * satisfies it, since a first mention may legitimately spell it out.
 */
export function checkGlossaryCompliance(
  entries: GlossaryEntry[],
  sourceText: string,
  translation: string,
): TranslationGlossaryCheck {
  const matched = findMatchingEntries(entries, sourceText);
  const violations: GlossaryViolation[] = [];
  for (const { entry, kind, matchedBy } of matched) {
    const shortFormPresent = termOccursIn(translation, entry.target, {
      caseSensitive: kind === 'acronym',
    });
    const expansionPresent =
      kind === 'acronym' &&
      !!entry.targetExpansion?.trim() &&
      termOccursIn(translation, entry.targetExpansion, {
        caseSensitive: false,
      });
    if (!shortFormPresent && !expansionPresent) {
      violations.push({
        source: entry.source,
        target: entry.target,
        kind,
        matchedBy,
      });
    }
  }
  return { checkedTerms: matched.length, violations };
}

/**
 * Normalizes a client-sent entry: trims, caps lengths, validates `kind`,
 * drops expansions that are not strings. Returns null for an entry with
 * no usable source/target. Route-side guard — the client is never trusted
 * for shape or size.
 */
export function sanitizeGlossaryEntry(raw: unknown): GlossaryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  const source = str(r.source, MAX_GLOSSARY_TERM_CHARS);
  const target = str(r.target, MAX_GLOSSARY_TERM_CHARS);
  if (!source || !target) return null;
  const entry: GlossaryEntry = { source, target };
  const note = str(r.note, MAX_GLOSSARY_NOTE_CHARS);
  if (note) entry.note = note;
  if (r.kind === 'term' || r.kind === 'acronym') entry.kind = r.kind;
  const sourceExpansion = str(r.sourceExpansion, MAX_GLOSSARY_TERM_CHARS);
  if (sourceExpansion) entry.sourceExpansion = sourceExpansion;
  const targetExpansion = str(r.targetExpansion, MAX_GLOSSARY_TERM_CHARS);
  if (targetExpansion) entry.targetExpansion = targetExpansion;
  return entry;
}
