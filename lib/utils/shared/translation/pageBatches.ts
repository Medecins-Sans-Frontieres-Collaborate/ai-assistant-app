/**
 * Page-level handling of an extracted document for the translation workflow.
 *
 * A document larger than one translation batch is not rejected: its text is
 * split into pages, a batch of consecutive pages that fits the character
 * budget is selected by default, and the user can change the selection.
 * Everything here is pure so the same rules serve the UI, the tests, and any
 * server caller.
 *
 * PAGE NUMBER CONVENTION (cited by every function in this file): page numbers
 * are 1-based and are the document's own page numbers. Pages with no text are
 * absent from the list, so numbers may have gaps and a list index is NOT a
 * page number.
 */

/** One page of extracted source text. */
export interface SourcePage {
  /** 1-based page number in the original document. */
  page: number;
  text: string;
}

/** Outcome of parsing a user-typed page selection such as "1-40, 45". */
export type PageSelectionResult =
  | { ok: true; pages: number[] }
  | { ok: false; reason: 'empty' | 'invalid' | 'unavailable'; detail?: string };

/**
 * Marker the pdf.js extractor writes before each page
 * (`extractTextWithPdfJs` in lib/utils/server/file/fileHandling.ts).
 */
const PAGE_MARKER = /^--- Page (\d+) ---[ \t]*$/gm;

/** Page separator emitted by the `pdftotext` fallback extractor. */
const FORM_FEED = '\f';

/** Separator placed between pages when they are joined into source text. */
export const PAGE_JOIN_SEPARATOR = '\n\n';

/**
 * Splits extracted document text into pages.
 *
 * Understands both shapes the server extractors produce: `--- Page N ---`
 * marker lines and form-feed separated pages. Text with neither is one page.
 * Markers are removed, so they never reach the translation.
 *
 * @param text - Extracted text as returned by `/api/file/process`.
 * @returns Pages that contain text, in document order.
 */
export function splitExtractedPages(text: string): SourcePage[] {
  const markers = [...text.matchAll(PAGE_MARKER)];
  if (markers.length > 0) {
    return markers
      .map((marker, index) => {
        const start = (marker.index ?? 0) + marker[0].length;
        const end = markers[index + 1]?.index ?? text.length;
        return { page: Number(marker[1]), text: text.slice(start, end).trim() };
      })
      .filter((page) => page.text !== '');
  }
  if (text.includes(FORM_FEED)) {
    return text
      .split(FORM_FEED)
      .map((pageText, index) => ({ page: index + 1, text: pageText.trim() }))
      .filter((page) => page.text !== '');
  }
  const trimmed = text.trim();
  return trimmed ? [{ page: 1, text: trimmed }] : [];
}

/**
 * Joins the selected pages into the source text sent for translation.
 *
 * @param pages - All pages of the document.
 * @param selected - Page numbers to include; order and duplicates are ignored.
 * @returns The selected pages' text in document order.
 */
export function joinPages(pages: SourcePage[], selected: number[]): string {
  const wanted = new Set(selected);
  return pages
    .filter((page) => wanted.has(page.page))
    .map((page) => page.text)
    .join(PAGE_JOIN_SEPARATOR);
}

/**
 * Character count of the text `joinPages` would produce for a selection.
 *
 * @param pages - All pages of the document.
 * @param selected - Page numbers to measure.
 */
export function selectionLength(
  pages: SourcePage[],
  selected: number[],
): number {
  return joinPages(pages, selected).length;
}

/**
 * Selects the batch of consecutive pages starting at a page that fits within
 * a character budget.
 *
 * @param pages - All pages of the document.
 * @param maxChars - Budget for the joined text, inclusive.
 * @param startPage - Page number to start from; the first page with text at
 *   or after it is used.
 * @returns Page numbers of the batch. Empty when no page exists at or after
 *   `startPage`, or when the first such page alone exceeds the budget.
 */
export function selectBatch(
  pages: SourcePage[],
  maxChars: number,
  startPage = 1,
): number[] {
  const batch: number[] = [];
  let length = 0;
  for (const page of pages) {
    if (page.page < startPage) continue;
    const added =
      page.text.length + (batch.length > 0 ? PAGE_JOIN_SEPARATOR.length : 0);
    if (length + added > maxChars) break;
    batch.push(page.page);
    length += added;
  }
  return batch;
}

/**
 * Selects the batch that ends just before a page, for stepping backwards.
 *
 * @param pages - All pages of the document.
 * @param maxChars - Budget for the joined text, inclusive.
 * @param beforePage - The batch ends at the last page with text before this
 *   page number.
 * @returns Page numbers of the batch in document order; empty when nothing
 *   precedes `beforePage` or the preceding page alone exceeds the budget.
 */
export function selectBatchEndingBefore(
  pages: SourcePage[],
  maxChars: number,
  beforePage: number,
): number[] {
  const batch: number[] = [];
  let length = 0;
  for (let index = pages.length - 1; index >= 0; index--) {
    const page = pages[index];
    if (page.page >= beforePage) continue;
    const added =
      page.text.length + (batch.length > 0 ? PAGE_JOIN_SEPARATOR.length : 0);
    if (length + added > maxChars) break;
    batch.unshift(page.page);
    length += added;
  }
  return batch;
}

/**
 * Formats page numbers as a compact selection string.
 *
 * @param selected - Page numbers in any order.
 * @returns Ranges such as `"1-40, 45"`; empty string for no pages.
 * @example formatPageSelection([3, 1, 2, 7]) // "1-3, 7"
 */
export function formatPageSelection(selected: number[]): string {
  const sorted = [...new Set(selected)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let rangeStart = sorted[0];
  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index];
    if (sorted[index + 1] === current + 1) continue;
    ranges.push(
      rangeStart === current ? String(current) : `${rangeStart}-${current}`,
    );
    rangeStart = sorted[index + 1];
  }
  return ranges.join(', ');
}

/**
 * Parses a user-typed page selection against the pages that exist.
 *
 * Accepts numbers and ranges separated by commas, semicolons, or spaces, with
 * a hyphen or en dash inside a range (`"1-40, 45"`, `"3 – 5"`). A range may
 * span pages without text; those are skipped. A selection that names no page
 * with text is `unavailable`.
 *
 * @param input - The text the user typed.
 * @param pages - All pages of the document.
 * @returns Sorted, de-duplicated page numbers, or why the input was refused.
 */
export function parsePageSelection(
  input: string,
  pages: SourcePage[],
): PageSelectionResult {
  const normalized = input.replace(/\s*[-–—]\s*/g, '-').trim();
  if (!normalized) return { ok: false, reason: 'empty' };

  const available = new Set(pages.map((page) => page.page));
  const selected = new Set<number>();
  for (const part of normalized.split(/[\s,;]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return { ok: false, reason: 'invalid', detail: part };
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first < 1 || last < first) {
      return { ok: false, reason: 'invalid', detail: part };
    }
    // Walk the pages that exist, not the numeric range: "1-999999" must not
    // loop a million times.
    for (const page of available) {
      if (page >= first && page <= last) selected.add(page);
    }
  }
  if (selected.size === 0) return { ok: false, reason: 'unavailable' };
  return { ok: true, pages: [...selected].sort((a, b) => a - b) };
}
