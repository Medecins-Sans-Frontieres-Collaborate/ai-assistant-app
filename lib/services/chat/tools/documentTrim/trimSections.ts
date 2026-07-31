/**
 * Section partitioning for the trim pipeline: identifies sections that are
 * conventionally NOT part of a document's word count and must survive a
 * trim untouched — reference lists, appendices, declarations. Those
 * sections are (a) excluded from the target arithmetic, (b) never shown to
 * the planner, and (c) locked + uncounted in the sandbox contract.
 */

/**
 * Headings whose sections are excluded from the count and protected from
 * edits. Matched against the heading TEXT (case-insensitive, from the
 * start) — covers the standard scholarly/report back-matter set.
 */
export const PROTECTED_HEADING_RE =
  /^(references|bibliography|works cited|citations|literature cited|acknowledge?ments?|appendix|appendices|supplementary(\s+(material|materials|files|information))?|funding|conflicts?\s+of\s+interest|competing\s+interests|declarations?|abbreviations|author\s+contributions?|ethics(\s+(statement|approval))?|data\s+availability(\s+statement)?|glossary|endnotes|footnotes)\b/i;

/** A markdown heading line: `# Title` … `###### Title`. */
const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * A standalone heading-ish line: short, no terminal period, optionally
 * bold/colon-suffixed. Pandoc extraction of .docx sometimes renders
 * headings this way instead of `#` syntax; only PROTECTED matches are
 * treated as headings in this looser form to avoid false section breaks.
 */
const STANDALONE_HEADING_RE = /^\s*\*{0,2}([^*\n]{1,60}?)\*{0,2}:?\s*$/;

export interface TrimPartition {
  /** The document with excluded sections removed — planner/count input. */
  countableText: string;
  /** Heading texts of excluded sections, as they appear in the document. */
  excludedHeadings: string[];
  /** Word count of everything excluded (for transparency in the result). */
  excludedWordCount: number;
}

function isProtectedHeadingLine(line: string): string | null {
  const md = line.match(MD_HEADING_RE);
  if (md) {
    return PROTECTED_HEADING_RE.test(md[2]) ? md[2] : null;
  }
  const standalone = line.match(STANDALONE_HEADING_RE);
  if (standalone && PROTECTED_HEADING_RE.test(standalone[1])) {
    return standalone[1].replace(/:$/, '').trim();
  }
  return null;
}

function isAnyHeadingLine(line: string): boolean {
  return MD_HEADING_RE.test(line) || isProtectedHeadingLine(line) !== null;
}

/**
 * Splits the extracted text into countable body vs. excluded back-matter.
 * An excluded section runs from its (protected) heading line to the next
 * heading line of any kind, or the end of the document — References is
 * typically terminal, so the common case is "everything after the
 * References heading".
 */
export function partitionForTrim(text: string): TrimPartition {
  const lines = text.split('\n');
  const countable: string[] = [];
  const excluded: string[] = [];
  const excludedHeadings: string[] = [];

  let inExcluded = false;
  for (const line of lines) {
    const protectedHeading = isProtectedHeadingLine(line);
    if (protectedHeading) {
      inExcluded = true;
      excludedHeadings.push(protectedHeading);
      excluded.push(line);
      continue;
    }
    if (inExcluded && isAnyHeadingLine(line)) {
      // A new (non-protected) section starts — back to countable.
      inExcluded = false;
    }
    (inExcluded ? excluded : countable).push(line);
  }

  const excludedText = excluded.join('\n');
  return {
    countableText: countable.join('\n'),
    excludedHeadings,
    excludedWordCount: excludedText.split(/\s+/).filter(Boolean).length,
  };
}
