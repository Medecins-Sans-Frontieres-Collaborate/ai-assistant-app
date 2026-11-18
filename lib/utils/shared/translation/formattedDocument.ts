/**
 * Pure rules of the Translation workspace's formatting-preserving document
 * layout: what a finished run looks like in workflow state, how a person's
 * edits relate to what is on the page, and how a re-render folds back in.
 *
 * ── Conventions (stated once; every caller cites these) ───────────────────
 *  - `run.units[].translation` is what the LAST RENDER put on the page
 *    (null = the unit was left as written).
 *  - `run.edits[id]` is what the person has changed since: a text, or null
 *    for "keep as written". An entry exists only while it differs from the
 *    rendered translation, so `edits` being empty means the PDF is current.
 *  - Text is edited as PLAIN text. The inline tags that carry bold, italics
 *    and links (see nativePdf.ts) are put back by {@link retagEditedText}.
 *  - Positions are page points from the top-left corner; the screen places
 *    them as percentages of the page (see {@link unitBox}).
 */
import {
  NATIVE_PDF_DEFAULT_DEPTH,
  NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
  NATIVE_PDF_MAX_PAGES,
  NativePdfDepth,
  NativePdfIssue,
  NativePdfPageStats,
  NativePdfRenderReport,
  NativePdfRunReport,
  NativePdfStepInstructions,
  NativePdfUnitResult,
  parsePageSelection,
  visibleLength,
} from '@/lib/utils/shared/translation/nativePdf';

/**
 * How Document mode produces its result. `text` sends the file through
 * document translation and reads the result as text, page by page.
 * `formatted` rebuilds each page with the translation in place.
 */
export const DOCUMENT_LAYOUTS = ['text', 'formatted'] as const;
export type TranslationDocumentLayout = (typeof DOCUMENT_LAYOUTS)[number];
export const DEFAULT_DOCUMENT_LAYOUT: TranslationDocumentLayout = 'text';

/** What the person chose for the next formatted run. */
export interface FormattedDocumentOptions {
  /** Page selection as typed, e.g. `"1-3, 8"`; empty means the first pages. */
  pages: string;
  instructions: NativePdfStepInstructions;
  refitRounds: number;
}

export const DEFAULT_FORMATTED_OPTIONS: FormattedDocumentOptions = {
  pages: '',
  instructions: {},
  refitRounds: NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
};

/** A finished formatted run and the person's edits to it. */
export interface FormattedDocumentRun extends NativePdfRunReport {
  /** `sourceDocument.url` the run was made from. */
  sourceUrl: string;
  sourceName: string;
  /** Display label of the target language. */
  targetLanguage: string;
  depth: NativePdfDepth;
  finishedAt: string;
  totalTokens: number;
  /** See the conventions above. */
  edits: Record<string, string | null>;
  /** 1-based page in view. */
  page: number;
  /** Keys ({@link issueKey}) of findings the person dismissed. */
  dismissed: string[];
}

export { NATIVE_PDF_DEFAULT_DEPTH, NATIVE_PDF_MAX_PAGES };

/** Why a formatted run cannot start. */
export type FormattedBlocker = 'no-document' | 'not-pdf' | 'no-language';

/**
 * Whether the loaded document can be translated with its formatting kept.
 * It needs a PDF kept on the server and any target language: the language
 * model translates, so custom languages work too.
 *
 * @param document - The uploaded document's reference, if any.
 * @param targetLanguage - Display label of the target language, if set.
 */
export function formattedEligibility(
  document: { url?: string; name: string } | undefined,
  targetLanguage: string | undefined,
): { ok: true } | { ok: false; reason: FormattedBlocker } {
  if (!document?.url) return { ok: false, reason: 'no-document' };
  if (!document.name.toLowerCase().endsWith('.pdf')) {
    return { ok: false, reason: 'not-pdf' };
  }
  if (!targetLanguage?.trim()) return { ok: false, reason: 'no-language' };
  return { ok: true };
}

/** Removes inline tags, leaving the text a person reads and types. */
export function plainText(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

const TAGGED_SPAN = /<(g\d+|b|i)>([\s\S]*?)<\/\1>/g;

/**
 * Puts inline tags back into text a person edited as plain text.
 *
 * Each tagged span of the previous text (a bold phrase, a link) is wrapped
 * again where its words still appear, searching left to right so two equal
 * phrases keep their order. A span whose words were changed loses its tag:
 * guessing which new words should be bold or linked would be wrong as often
 * as right, and the count of dropped spans is returned so the screen can
 * say so.
 *
 * @param previous - The text before the edit, with its tags.
 * @param edited - The text as typed, without tags.
 * @returns The edited text with every recoverable tag, and how many spans
 *   lost theirs.
 */
export function retagEditedText(
  previous: string,
  edited: string,
): { text: string; dropped: number } {
  let text = '';
  let cursor = 0;
  let dropped = 0;
  for (const span of previous.matchAll(TAGGED_SPAN)) {
    const inner = plainText(span[2]);
    const at = inner ? edited.indexOf(inner, cursor) : -1;
    if (at === -1) {
      dropped += 1;
      continue;
    }
    text += edited.slice(cursor, at) + span[0];
    cursor = at + inner.length;
  }
  return { text: text + edited.slice(cursor), dropped };
}

/** The unit's translation as the person now has it; null = kept as written. */
export function currentTranslation(
  run: Pick<FormattedDocumentRun, 'edits'>,
  unit: Pick<NativePdfUnitResult, 'id' | 'translation'>,
): string | null {
  return unit.id in run.edits ? run.edits[unit.id] : unit.translation;
}

const sameText = (a: string | null, b: string | null): boolean =>
  (a ?? '').trim() === (b ?? '').trim() && (a === null) === (b === null);

/**
 * Records an edit to one unit. An edit that brings the unit back to what is
 * on the page removes the entry (see the conventions above).
 *
 * @param run - The run being edited.
 * @param id - The unit's id; an unknown id leaves the run unchanged.
 * @param text - The new translation with tags, or null to keep the unit as
 *   written. An empty text also means keep as written.
 * @returns The run with the edit recorded.
 */
export function withUnitEdit(
  run: FormattedDocumentRun,
  id: string,
  text: string | null,
): FormattedDocumentRun {
  const unit = run.units.find((candidate) => candidate.id === id);
  if (!unit) return run;
  const value = text !== null && text.trim() ? text.trim() : null;
  const edits = { ...run.edits };
  if (sameText(value, unit.translation)) delete edits[id];
  else edits[id] = value;
  return { ...run, edits };
}

/** Units whose text differs from what is on the page, in document order. */
export function editedUnits(run: FormattedDocumentRun): NativePdfUnitResult[] {
  return run.units.filter((unit) => unit.id in run.edits);
}

/** Pages with at least one edit that is not on the page yet, ascending. */
export function stalePages(run: FormattedDocumentRun): number[] {
  return [...new Set(editedUnits(run).map((unit) => unit.page))].sort(
    (a, b) => a - b,
  );
}

/**
 * Every unit's translation for a re-render: the edits over the rendered
 * text. A unit kept as written has no entry.
 */
export function translationsForRender(
  run: FormattedDocumentRun,
): Record<string, string> {
  const translations: Record<string, string> = {};
  for (const unit of run.units) {
    const text = currentTranslation(run, unit);
    if (text !== null && text.trim()) translations[unit.id] = text;
  }
  return translations;
}

/**
 * Folds a re-render into the run: the edits become the rendered text, each
 * unit takes its new fit, and the findings of the pages that were checked
 * again replace the old ones (other pages keep theirs).
 *
 * A unit the server refused as too long keeps its edit, so the person sees
 * it is still not on the page.
 *
 * @param run - The run as it was sent for rendering.
 * @param report - The server's answer.
 */
export function applyRenderReport(
  run: FormattedDocumentRun,
  report: NativePdfRenderReport,
): FormattedDocumentRun {
  const fits = new Map(report.fits.map((fit) => [fit.id, fit]));
  const refused = new Set(report.tooLong);
  const checked = new Set(report.checkedPages);
  const edits: Record<string, string | null> = {};
  const units = run.units.map((unit) => {
    if (refused.has(unit.id)) {
      edits[unit.id] = run.edits[unit.id] ?? null;
      return unit;
    }
    const fit = fits.get(unit.id);
    return {
      ...unit,
      translation: currentTranslation(run, unit),
      scale: fit?.scale ?? null,
      fits: fit?.fits ?? null,
      refitted: unit.id in run.edits ? false : unit.refitted,
    };
  });
  return {
    ...run,
    units,
    edits,
    issues: [
      ...run.issues.filter((issue) => !checked.has(issue.page)),
      ...report.issues,
    ],
    uncheckedPages: [
      ...(run.uncheckedPages ?? []).filter((page) => !checked.has(page)),
      ...report.uncheckedPages.filter(
        (page) => !(run.uncheckedPages ?? []).includes(page),
      ),
    ],
    fonts: report.fonts,
    pdfUrl: report.pdfUrl,
    pageImages: report.pageImages,
  };
}

/** Stable name of a finding, used to remember that it was dismissed. */
export function issueKey(issue: NativePdfIssue): string {
  return `${issue.page}:${issue.n ?? 'page'}:${issue.kind}`;
}

/** A page's findings that the person has not dismissed. */
export function openIssues(
  run: FormattedDocumentRun,
  page: number,
): NativePdfIssue[] {
  const dismissed = new Set(run.dismissed);
  return run.issues.filter(
    (issue) => issue.page === page && !dismissed.has(issueKey(issue)),
  );
}

/** A box as CSS percentages of its page. */
export interface PercentBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** Points added around a unit's box so its outline does not touch the text. */
const BOX_PADDING_POINTS = 2;

/**
 * Where a unit sits on its page, as percentages, so the outline scales with
 * the page image at any size.
 *
 * @param box - `[x0, y0, x1, y1]` in page points from the top-left corner.
 * @param page - The page's size in points.
 */
export function unitBox(
  box: [number, number, number, number],
  page: Pick<NativePdfPageStats, 'width' | 'height'>,
): PercentBox {
  const percent = (value: number, of: number) =>
    `${Math.min(Math.max((value / of) * 100, 0), 100).toFixed(3)}%`;
  const [x0, y0, x1, y1] = box;
  return {
    left: percent(x0 - BOX_PADDING_POINTS, page.width),
    top: percent(y0 - BOX_PADDING_POINTS, page.height),
    width: percent(x1 - x0 + 2 * BOX_PADDING_POINTS, page.width),
    height: percent(y1 - y0 + 2 * BOX_PADDING_POINTS, page.height),
  };
}

/**
 * Share of the budget a text may exceed before the screen warns. The budget
 * is an estimate from the source's length, and a text a character or two
 * over it lays out at full size.
 */
export const FIT_TOLERANCE = 0.05;

/** Whether a text is likely to be set smaller to fit its unit. */
export interface FitEstimate {
  chars: number;
  budget: number;
  /** True when the text is likely to be shrunk. */
  tight: boolean;
}

/**
 * Estimates, before rendering, whether a text fits its unit at full size.
 *
 * @param text - The translation, with or without tags.
 * @param budgetChars - The unit's character budget (see charBudget).
 */
export function fitEstimate(text: string, budgetChars: number): FitEstimate {
  const chars = visibleLength(text);
  return {
    chars,
    budget: budgetChars,
    tight: chars > budgetChars * (1 + FIT_TOLERANCE),
  };
}

/**
 * Builds the stored run from the server's report.
 *
 * @param report - The finished run.
 * @param meta - What the client knows and the server does not.
 */
export function runFromReport(
  report: NativePdfRunReport,
  meta: Pick<
    FormattedDocumentRun,
    'sourceUrl' | 'sourceName' | 'targetLanguage' | 'depth' | 'totalTokens'
  >,
): FormattedDocumentRun {
  return {
    steps: report.steps,
    pageCount: report.pageCount,
    pages: report.pages,
    units: report.units,
    issues: report.issues,
    uncheckedPages: report.uncheckedPages,
    fonts: report.fonts,
    refitRounds: report.refitRounds,
    pdfUrl: report.pdfUrl,
    pageImages: report.pageImages,
    sourceId: report.sourceId,
    unitsId: report.unitsId,
    ...meta,
    finishedAt: new Date().toISOString(),
    edits: {},
    page: report.pageImages[0]?.page ?? report.pages[0]?.page ?? 1,
    dismissed: [],
  };
}

/**
 * Writes page numbers as a selection, joining runs into ranges.
 *
 * @example formatPageSelection([1, 2, 3, 8]) // "1-3, 8"
 */
export function formatPageSelection(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    let end = index;
    while (sorted[end + 1] === sorted[end] + 1) end += 1;
    parts.push(
      end === index ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`,
    );
    index = end;
  }
  return parts.join(', ');
}

/**
 * The pages a selection names, limited to the pages the document has.
 *
 * @param spec - The selection as typed; empty means the first pages.
 * @param pageCount - Pages in the document.
 * @param maxPages - Most pages one run takes.
 * @returns The pages, or `error` when the selection cannot be read or
 *   names more pages than a run takes.
 */
export function selectedPages(
  spec: string,
  pageCount: number,
  maxPages: number,
): { ok: true; pages: number[] } | { ok: false; error: string } {
  const parsed = parsePageSelection(spec, maxPages);
  if (!parsed.ok) return parsed;
  return { ok: true, pages: parsed.pages.filter((page) => page <= pageCount) };
}

/**
 * Adds or removes one page from a selection.
 *
 * The last selected page cannot be removed: an empty selection means "the
 * first pages" (see selectedPages), so removing it would select more pages,
 * not none.
 *
 * @returns The new selection, or null when adding the page would exceed
 *   `maxPages` (the selection is then left as it is).
 */
export function togglePage(
  pages: number[],
  page: number,
  maxPages: number,
): string | null {
  if (pages.includes(page)) {
    const rest = pages.filter((other) => other !== page);
    return formatPageSelection(rest.length > 0 ? rest : pages);
  }
  if (pages.length >= maxPages) return null;
  return formatPageSelection([...pages, page]);
}
