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
 *  - A document is translated in BATCHES. A run holds every batch so far:
 *    `run.units` covers all translated pages, and a page is "translated"
 *    when the run has a unit on it ({@link translatedPages}). One batch may
 *    take several requests (splitIntoRequests in nativePdf.ts); the pieces
 *    are joined by {@link combineRuns} and one render.
 *  - The DOWNLOAD is the whole document: translated pages replaced, every
 *    other page as it is in the source. `run.removedPages` are the source
 *    pages the person wants left out of it; `run.pdfRemovedPages` are the
 *    ones the PDF at `run.pdfUrl` actually leaves out. The two differ only
 *    until the next render ({@link removalPending}). Page numbers always
 *    mean pages of the SOURCE, whatever the download leaves out.
 *  - A unit's LOOK can be changed: font size, colour and position
 *    (NativePdfUnitStyle in nativePdf.ts, which also states which way a
 *    move goes). `run.styles[id]` is the look the person wants,
 *    `run.pdfStyles[id]` the one the last render used; a unit is restyled
 *    while the two differ ({@link restyledUnits}). An absent entry means
 *    the source's own look.
 *  - Positions are page points from the top-left corner; the screen places
 *    them as percentages of the page (see {@link unitBox}).
 */
import { nativeUploadExtension } from '@/lib/utils/shared/translation/nativeFormats';
import {
  NATIVE_PDF_DEFAULT_DEPTH,
  NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
  NATIVE_PDF_MAX_PAGES,
  NativePdfDepth,
  NativePdfExportUrls,
  NativePdfIssue,
  NativePdfLimits,
  NativePdfPageImages,
  NativePdfPageStats,
  NativePdfRenderReport,
  NativePdfRunReport,
  NativePdfStepInstructions,
  NativePdfUnitResult,
  NativePdfUnitStyle,
  parsePageSelection,
  sanitizeUnitStyle,
  visibleLength,
} from '@/lib/utils/shared/translation/nativePdf';
import type { NativeRunRef } from '@/lib/utils/shared/translation/nativeRunStorage';

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
  /**
   * Page selection as typed, e.g. `"1-3, 8"`; empty means the first pages
   * that are not translated yet.
   */
  pages: string;
  /**
   * Pages per batch as the person raised or lowered it; absent means the
   * admin's default. Always read through {@link planBatch}, which holds it
   * inside the person's limits.
   */
  batchPages?: number;
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
  /** Batches put into this run so far; absent on runs of a single batch. */
  batches?: number;
  /**
   * A presentation: whether its speaker notes were translated (as the
   * person chose when it started). Absent for a PDF.
   */
  translateNotes?: boolean;
  /** Unit id to the look the person wants (see the conventions). */
  styles?: Record<string, NativePdfUnitStyle>;
  /** Unit id to the look the last render used. */
  pdfStyles?: Record<string, NativePdfUnitStyle>;
  /** Source pages to leave out of the download (see the conventions). */
  removedPages?: number[];
  /** Source pages the PDF at `pdfUrl` leaves out. */
  pdfRemovedPages?: number[];
  /**
   * The editable files built with the PDF at `pdfUrl` (EDITABLE DOWNLOADS
   * in nativePdf.ts); absent when that render was not asked for any.
   */
  exportUrls?: NativePdfExportUrls;
}

export { NATIVE_PDF_DEFAULT_DEPTH, NATIVE_PDF_MAX_PAGES };

/**
 * A presentation being translated in the background (THE JOB CONVENTION in
 * deckRunJob.ts), as workflow state remembers it: enough to follow the job
 * again after a reload, and to turn its batches into the run.
 */
export interface FormattedPendingJob {
  /** Where the job's run is stored. */
  access: Pick<NativeRunRef, 'runId' | 'backend' | 'keyId'>;
  sourceUrl: string;
  sourceName: string;
  /** Display label of the target language. */
  targetLanguage: string;
  depth: NativePdfDepth;
  /** The job adds slides to the run stored when it started. */
  addsToBase: boolean;
  /** Epoch milliseconds it started at. */
  startedAt: number;
}

/** Why a formatted run cannot start. */
export type FormattedBlocker =
  | 'no-document'
  | 'unsupported-format'
  | 'no-language';

/**
 * Whether the loaded document can be translated with its formatting kept.
 * It needs a PDF or a presentation (NATIVE_UPLOAD_EXTENSIONS) kept on the
 * server and any target language: the language model translates, so custom
 * languages work too.
 *
 * @param document - The uploaded document's reference, if any.
 * @param targetLanguage - Display label of the target language, if set.
 */
export function formattedEligibility(
  document: { url?: string; name: string } | undefined,
  targetLanguage: string | undefined,
): { ok: true } | { ok: false; reason: FormattedBlocker } {
  if (!document?.url) return { ok: false, reason: 'no-document' };
  if (!nativeUploadExtension(document.name)) {
    return { ok: false, reason: 'unsupported-format' };
  }
  if (!targetLanguage?.trim()) return { ok: false, reason: 'no-language' };
  return { ok: true };
}

/** Removes inline tags, leaving the text a person reads and types. */
export function plainText(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/**
 * Rows a text field needs to show `text` whole: each line (a line break
 * starts one, see BREAKS in the layout script) takes at least a row, and a
 * long line the rows its characters fill.
 *
 * @param text - The field's text.
 * @param charsPerRow - Characters that fit on one row of the field.
 * @param limits - Fewest and most rows to answer.
 * @example textRows('one\ntwo', 50, { min: 1, max: 10 }) // 2
 */
export function textRows(
  text: string,
  charsPerRow: number,
  limits: { min: number; max: number },
): number {
  const rows = text
    .split('\n')
    .reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerRow)),
      0,
    );
  return Math.min(Math.max(rows, limits.min), limits.max);
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

const STYLE_FIELDS = ['size', 'color', 'dx', 'dy'] as const;

/** Whether two looks are the same; an absent look equals an empty one. */
export function sameUnitStyle(
  a: NativePdfUnitStyle | undefined,
  b: NativePdfUnitStyle | undefined,
): boolean {
  return STYLE_FIELDS.every((field) => a?.[field] === b?.[field]);
}

/** The look the person wants for a unit; empty means the source's own. */
export function unitStyle(
  run: Pick<FormattedDocumentRun, 'styles'>,
  id: string,
): NativePdfUnitStyle {
  return run.styles?.[id] ?? {};
}

/** Units whose look differs from what is on the page, in document order. */
export function restyledUnits(
  run: FormattedDocumentRun,
): NativePdfUnitResult[] {
  return run.units.filter(
    (unit) => !sameUnitStyle(run.styles?.[unit.id], run.pdfStyles?.[unit.id]),
  );
}

/**
 * Units that differ from what is on the page in their text or their look,
 * in document order. These are what a re-render puts on the page.
 */
export function changedUnits(run: FormattedDocumentRun): NativePdfUnitResult[] {
  const restyled = new Set(restyledUnits(run).map((unit) => unit.id));
  return run.units.filter(
    (unit) => unit.id in run.edits || restyled.has(unit.id),
  );
}

/**
 * Changes a unit's look. Fields of `change` replace the unit's; a field
 * set to `undefined` goes back to the source's own. Values are held inside
 * their ranges (sanitizeUnitStyle), and a size or colour equal to the
 * source's is not kept as a change.
 *
 * @param run - The run.
 * @param id - The unit.
 * @param change - Fields to set, or null to drop the unit's whole look.
 */
export function withUnitStyle(
  run: FormattedDocumentRun,
  id: string,
  change: Partial<NativePdfUnitStyle> | null,
): FormattedDocumentRun {
  const unit = run.units.find((candidate) => candidate.id === id);
  if (!unit) return run;
  const merged = change ? { ...unitStyle(run, id), ...change } : {};
  const style = sanitizeUnitStyle(merged) ?? {};
  if (style.size === unit.size) delete style.size;
  if (style.color === unit.color?.toLowerCase()) delete style.color;
  const styles = { ...(run.styles ?? {}) };
  if (Object.keys(style).length > 0) styles[id] = style;
  else delete styles[id];
  return { ...run, styles };
}

/**
 * A box moved by a unit's look, for showing on the page where the unit's
 * translation will be laid out.
 *
 * @param box - `[x0, y0, x1, y1]` in page points.
 * @param style - The unit's look.
 */
export function movedBox(
  box: [number, number, number, number],
  style: NativePdfUnitStyle | undefined,
): [number, number, number, number] {
  const dx = style?.dx ?? 0;
  const dy = style?.dy ?? 0;
  return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
}

/**
 * ZOOM of the page view. 1 shows the page at its normal width (PAGE_WIDTH in
 * FormattedPageView). The buttons and Ctrl/Cmd with +, - and 0 step through
 * PAGE_ZOOM_LEVELS; a pinch or Ctrl+wheel goes anywhere between the first
 * and the last.
 */
export const PAGE_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5] as const;
export const DEFAULT_PAGE_ZOOM = 1;
export const MIN_PAGE_ZOOM = PAGE_ZOOM_LEVELS[0];
export const MAX_PAGE_ZOOM = PAGE_ZOOM_LEVELS[PAGE_ZOOM_LEVELS.length - 1];
/** Zoom levels closer than this are the same level (a pinch lands between). */
export const PAGE_ZOOM_EPSILON = 0.001;

/** A zoom level kept between MIN_PAGE_ZOOM and MAX_PAGE_ZOOM. */
export function clampPageZoom(zoom: number): number {
  return Math.min(MAX_PAGE_ZOOM, Math.max(MIN_PAGE_ZOOM, zoom));
}

/**
 * The zoom level one step in or out from the current one. A level between
 * two (after a pinch) steps to the next one in that direction.
 *
 * @param zoom - The current level.
 * @param direction - `1` to zoom in, `-1` to zoom out.
 * @returns The next level, or the current one at either end.
 */
export function nextPageZoom(zoom: number, direction: 1 | -1): number {
  const levels: readonly number[] = PAGE_ZOOM_LEVELS;
  if (direction > 0) {
    return (
      levels.find((level) => level > zoom + PAGE_ZOOM_EPSILON) ??
      levels[levels.length - 1]
    );
  }
  return (
    [...levels].reverse().find((level) => level < zoom - PAGE_ZOOM_EPSILON) ??
    levels[0]
  );
}

/** How much one pixel of wheel delta zooms (0.2% a pixel). */
const WHEEL_ZOOM_PER_PX = 0.002;

/**
 * The zoom level after a pinch or Ctrl+wheel: each unit of wheel delta
 * scales the page a little, so a trackpad pinch and a mouse wheel's notch
 * both feel proportionate. Negative delta (wheel up, fingers apart) zooms in.
 *
 * @param zoom - The current level.
 * @param deltaPx - The wheel's vertical delta, in pixels.
 */
export function wheelPageZoom(zoom: number, deltaPx: number): number {
  return clampPageZoom(zoom * Math.exp(-deltaPx * WHEEL_ZOOM_PER_PX));
}

/**
 * Pages with a change, in text or look, that is not on the page yet,
 * ascending.
 */
export function stalePages(run: FormattedDocumentRun): number[] {
  return [...new Set(changedUnits(run).map((unit) => unit.page))].sort(
    (a, b) => a - b,
  );
}

/** Source pages the person wants left out of the download, ascending. */
export function removedPages(
  run: Pick<FormattedDocumentRun, 'removedPages'> | undefined,
): number[] {
  return [...new Set(run?.removedPages ?? [])].sort((a, b) => a - b);
}

/**
 * Whether the download does not yet leave out exactly the pages the person
 * removed (a page was removed or put back since the last render).
 */
export function removalPending(
  run: Pick<FormattedDocumentRun, 'removedPages' | 'pdfRemovedPages'>,
): boolean {
  const wanted = removedPages(run);
  const inPdf = removedPages({ removedPages: run.pdfRemovedPages });
  return (
    wanted.length !== inPdf.length ||
    wanted.some((page, index) => page !== inPdf[index])
  );
}

/**
 * Removes a page from the download, or puts it back.
 *
 * The last page left cannot be removed: a download needs a page. The run
 * is then returned unchanged.
 *
 * @param run - The run.
 * @param page - 1-based source page.
 * @param removed - True to leave the page out, false to put it back.
 * @param pageCount - Pages in the source document.
 */
export function withPageRemoved(
  run: FormattedDocumentRun,
  page: number,
  removed: boolean,
  pageCount: number,
): FormattedDocumentRun {
  const current = removedPages(run);
  if (removed === current.includes(page)) return run;
  if (removed && current.length >= pageCount - 1) return run;
  const next = removed
    ? [...current, page].sort((a, b) => a - b)
    : current.filter((other) => other !== page);
  return { ...run, removedPages: next };
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
    // A presentation's translated deck, built by the same render; an
    // earlier one would no longer match the PDF.
    documentUrl: report.documentUrl,
    // Only what this render built describes its PDF.
    exportUrls: report.exportUrls,
    // The render used the looks of the run as it was sent.
    pdfStyles: run.styles ?? {},
    // The render left out the pages removed in the run as it was sent.
    pdfRemovedPages: removedPages(run),
    // The render returns images of the pages that changed only.
    pageImages: mergeByPage(run.pageImages, report.pageImages),
    unitsId: report.unitsId ?? run.unitsId,
  };
}

/** Two per-page lists as one, in page order; `added` wins on a shared page. */
function mergeByPage<Item extends { page: number }>(
  kept: Item[],
  added: Item[],
): Item[] {
  const replaced = new Set(added.map((item) => item.page));
  return [...kept.filter((item) => !replaced.has(item.page)), ...added].sort(
    (a, b) => a.page - b.page,
  );
}

/** Pages the run holds a translation for, ascending. */
export function translatedPages(
  run: Pick<FormattedDocumentRun, 'units'> | undefined,
): number[] {
  return [...new Set((run?.units ?? []).map((unit) => unit.page))].sort(
    (a, b) => a - b,
  );
}

/** The entries of a per-unit record whose unit is still in the run. */
function keptOnly<T>(
  record: Record<string, T> | undefined,
  keptIds: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record ?? {}).filter(([id]) => keptIds.has(id)),
  );
}

/**
 * Joins the pieces of a document's translation into one run, BEFORE the
 * render that makes one PDF of them: `pdfUrl` is still the last piece's and
 * `unitsId` is not valid for the whole until {@link applyRenderReport} has
 * folded that render in.
 *
 * A page present in two pieces is taken from the later one, with its
 * findings; pending edits to it are dropped with the text they applied to.
 *
 * @param base - The run so far (earlier batches), if any.
 * @param pieces - The new batch, one run per request, in order; at least
 *   one when `base` is absent.
 * @returns The joined run, showing the first page of the new batch.
 * @throws Error when there is nothing to join.
 */
export function combineRuns(
  base: FormattedDocumentRun | undefined,
  pieces: FormattedDocumentRun[],
): FormattedDocumentRun {
  const all = base ? [base, ...pieces] : pieces;
  const last = all[all.length - 1];
  if (!last) throw new Error('No translated pages to put together');
  if (all.length === 1) return last;
  let joined = all[0];
  for (const piece of all.slice(1)) {
    const replaced = new Set(piece.pages.map((page) => page.page));
    const keptUnits = joined.units.filter((unit) => !replaced.has(unit.page));
    const keptIds = new Set(keptUnits.map((unit) => unit.id));
    joined = {
      ...joined,
      pages: mergeByPage(joined.pages, piece.pages),
      units: [...keptUnits, ...piece.units].sort(
        (a, b) => a.page - b.page || a.n - b.n,
      ),
      issues: [
        ...joined.issues.filter((issue) => !replaced.has(issue.page)),
        ...piece.issues,
      ],
      uncheckedPages: [
        ...(joined.uncheckedPages ?? []).filter((page) => !replaced.has(page)),
        ...(piece.uncheckedPages ?? []),
      ].sort((a, b) => a - b),
      pageImages: mergeByPage(joined.pageImages, piece.pageImages),
      edits: Object.fromEntries(
        Object.entries(joined.edits).filter(([id]) => keptIds.has(id)),
      ),
      // A page translated again starts from its new batch's looks.
      styles: {
        ...keptOnly(joined.styles, keptIds),
        ...(piece.styles ?? {}),
      },
      pdfStyles: {
        ...keptOnly(joined.pdfStyles, keptIds),
        ...(piece.pdfStyles ?? {}),
      },
      totalTokens: joined.totalTokens + piece.totalTokens,
      // Each request returns the brief it was given with its own decisions
      // added, so the latest one holds them all.
      ...((piece.brief ?? joined.brief)
        ? { brief: piece.brief ?? joined.brief }
        : {}),
    };
  }
  return {
    ...joined,
    // What the person sees of "the run" is its latest batch.
    steps: last.steps,
    fonts: last.fonts,
    refitRounds: last.refitRounds,
    pdfUrl: last.pdfUrl,
    documentUrl: last.documentUrl,
    exportUrls: undefined,
    targetLanguage: last.targetLanguage,
    depth: last.depth,
    finishedAt: last.finishedAt,
    page: pieces[0]?.page ?? last.page,
    batches: (base?.batches ?? (base ? 1 : 0)) + (pieces.length > 0 ? 1 : 0),
  };
}

/**
 * How a page shows in the setup. Exactly one applies to each page:
 *  - `translated`: an earlier batch did it.
 *  - `selected`: it is in the batch about to run.
 *  - `available`: it can still be added to this batch.
 *  - `later`: this batch is full, but the document limit leaves room for it
 *    in another batch.
 *  - `locked`: the document limit is used up; it cannot be translated.
 */
export type BatchPageState =
  | 'translated'
  | 'selected'
  | 'available'
  | 'later'
  | 'locked'
  | 'removed';

/** Why a selection cannot be run as it is. */
export type BatchProblem = 'unreadable' | 'over-batch' | 'none-left';

/** The batch about to run, and where every page of the document stands. */
export interface BatchPlan {
  /** Pages the batch will translate, ascending; empty when `problem`. */
  pages: number[];
  problem?: BatchProblem;
  /** Pages the selection named, when that was more than `capacity`. */
  asked?: number;
  /** Pages per batch in force: the person's choice held inside the limits. */
  batchPages: number;
  /** Pages this batch can take: `batchPages`, or less near the limit. */
  capacity: number;
  /** Pages the document limit still allows, this batch included. */
  allowance: number;
  /** Pages earlier batches translated, ascending. */
  translated: number[];
  /** Pages removed from the download, ascending; never part of a batch. */
  removed: number[];
  limits: NativePdfLimits;
}

/**
 * Works out the next batch from what the person typed or ticked.
 *
 * An empty selection means the first pages not translated yet, as many as
 * the batch takes. Pages already translated are never part of a batch;
 * naming one is not an error, it is left out.
 *
 * @param input.spec - The selection as typed.
 * @param input.pageCount - Pages in the document (0 while unknown).
 * @param input.translated - Pages earlier batches translated.
 * @param input.removed - Pages the person removed from the download.
 * @param input.batchPages - Pages per batch the person asked for, if any.
 * @param input.limits - The person's limits.
 */
export function planBatch(input: {
  spec: string;
  pageCount: number;
  translated: number[];
  removed?: number[];
  batchPages?: number;
  limits: NativePdfLimits;
}): BatchPlan {
  const { limits } = input;
  const translated = [...new Set(input.translated)].sort((a, b) => a - b);
  const removed = removedPages({ removedPages: input.removed });
  // Out of reach for a batch: done already, or not wanted in the download.
  const done = new Set([...translated, ...removed]);
  const batchPages = Math.min(
    Math.max(Math.floor(input.batchPages ?? limits.defaultBatchPages), 1),
    limits.maxBatchPages,
  );
  const allowance = Math.max(limits.maxDocumentPages - translated.length, 0);
  const capacity = Math.min(batchPages, allowance);
  const plan = { batchPages, capacity, allowance, translated, removed, limits };
  const open = Array.from(
    { length: input.pageCount },
    (_, index) => index + 1,
  ).filter((page) => !done.has(page));
  if (!input.spec.trim()) {
    const pages = open.slice(0, capacity);
    return pages.length > 0
      ? { ...plan, pages }
      : { ...plan, pages, problem: 'none-left' };
  }
  // Parsed against a generous cap, not the batch's: the batch's capacity is
  // applied after translated pages are left out.
  const parsed = parsePageSelection(input.spec, MAX_NAMED_PAGES);
  if (!parsed.ok) return { ...plan, pages: [], problem: 'unreadable' };
  const pages = parsed.pages.filter(
    (page) => page <= input.pageCount && !done.has(page),
  );
  if (pages.length === 0) return { ...plan, pages, problem: 'none-left' };
  if (pages.length > capacity) {
    return { ...plan, pages: [], problem: 'over-batch', asked: pages.length };
  }
  return { ...plan, pages };
}

/**
 * The plan for a batch made of exactly the pages a person ticked, as on the
 * finished translation's page list. Unlike {@link planBatch}, ticking
 * nothing means an empty batch, not the first pages.
 *
 * @param input.ticked - The ticked pages, in any order.
 * @returns A plan whose `pages` are the ticked pages a batch can take:
 *   untranslated, not removed, inside the document, and no more than the
 *   batch's capacity (the lowest page numbers are kept).
 */
export function planTickedBatch(input: {
  ticked: number[];
  pageCount: number;
  translated: number[];
  removed?: number[];
  batchPages?: number;
  limits: NativePdfLimits;
}): BatchPlan {
  const { ticked, ...rest } = input;
  const plan = planBatch({ ...rest, spec: '' });
  const closed = new Set([...plan.translated, ...plan.removed]);
  const pages = [...new Set(ticked)]
    .filter((page) => page >= 1 && page <= input.pageCount && !closed.has(page))
    .sort((a, b) => a - b)
    .slice(0, plan.capacity);
  return { ...plan, pages, problem: undefined };
}

/** Most pages a typed selection may name before it is refused as unreadable. */
const MAX_NAMED_PAGES = 5_000;

/** Where one page stands under a plan (see {@link BatchPageState}). */
export function batchPageState(plan: BatchPlan, page: number): BatchPageState {
  if (plan.removed.includes(page)) return 'removed';
  if (plan.translated.includes(page)) return 'translated';
  if (plan.pages.includes(page)) return 'selected';
  if (plan.pages.length < plan.capacity) return 'available';
  // The batch is full. Whether another batch could take the page depends
  // on what the document limit leaves after this one.
  return plan.allowance > plan.pages.length ? 'later' : 'locked';
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
    // The automatic fixes' looks are on the page already.
    styles: report.styles ?? {},
    pdfStyles: report.styles ?? {},
    ...(report.brief ? { brief: report.brief } : {}),
    pdfUrl: report.pdfUrl,
    ...(report.format ? { format: report.format } : {}),
    ...(report.documentUrl ? { documentUrl: report.documentUrl } : {}),
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
