/**
 * Native PDF translation: the pure rules shared by the pipeline, its route
 * and its tests. No server imports, no model calls.
 *
 * ── Conventions (stated once; every caller cites these) ───────────────────
 *  - Page numbers are 1-based.
 *  - A UNIT is the smallest piece translated and refitted as one: a
 *    paragraph, or a single line where lines do not stack into a paragraph.
 *    Its `id` is stable across the run; its `n` is a per-page number used
 *    only to point at it in an image.
 *  - Inline formatting inside a unit's text is carried by NUMBERED TAGS
 *    (`<g1>…</g1>`) plus literal `<b>` and `<i>`. A translation may reorder
 *    tags but may not invent, drop or leave one unbalanced.
 *  - SCALE is the factor the layout engine shrank a translation by to make it
 *    fit its room: 1 is unshrunk. Lower is worse.
 *  - The steps run in the order of {@link NATIVE_PDF_STEPS}, every one of
 *    them on every run. Caller-supplied instructions can add to a step's
 *    prompt; they can never remove or reorder a step.
 */

/** The fixed step sequence. `instructable` steps accept added instructions. */
export const NATIVE_PDF_STEPS = [
  { id: 'extract', instructable: false },
  { id: 'analyze', instructable: true },
  { id: 'translate', instructable: true },
  { id: 'rebuild', instructable: false },
  { id: 'verify', instructable: true },
  { id: 'refit', instructable: false },
] as const;

export type NativePdfStepId = (typeof NATIVE_PDF_STEPS)[number]['id'];

export type NativePdfInstructableStep = Extract<
  (typeof NATIVE_PDF_STEPS)[number],
  { instructable: true }
>['id'];

/** Extra guidance per step, appended to that step's fixed prompt. */
export type NativePdfStepInstructions = Partial<
  Record<NativePdfInstructableStep, string>
>;

export const MAX_STEP_INSTRUCTION_CHARS = 2_000;

/**
 * The admin-policy feature that switches this pipeline on or off
 * (Admin > Workflows, under Translation).
 */
export const NATIVE_PDF_FEATURE = 'translation-preserve-formatting';

/**
 * Pages ONE REQUEST may process: it bounds the request's time. A batch
 * larger than this is sent as several requests, one after the other (see
 * splitIntoRequests); how large a batch or a document may be is an admin
 * setting (see NativePdfLimits), not this constant.
 */
export const NATIVE_PDF_MAX_PAGES = 6;

/** Pages one re-render may run the layout check on. */
export const NATIVE_PDF_MAX_CHECK_PAGES = 24;

/** Extractions (one per request of a document) one re-render may combine. */
export const NATIVE_PDF_MAX_EXTRACTIONS = 40;

/**
 * How many pages a person may translate, as an admin set it for them
 * (Admin > Workflows, under Translation). Invariant, kept by
 * {@link nativePdfLimits}: defaultBatchPages ≤ maxBatchPages ≤
 * maxDocumentPages.
 */
/**
 * Most pages a render may be asked to leave out of the result. A bound on
 * the request's size, far above any document the pipeline is used for.
 */
export const NATIVE_PDF_MAX_OMITTED_PAGES = 5_000;

export interface NativePdfLimits {
  /** Pages a batch takes unless the person raises it. */
  defaultBatchPages: number;
  /** The most a person may raise one batch to. */
  maxBatchPages: number;
  /** Pages of one document that may be translated in total. */
  maxDocumentPages: number;
}

/** Limits used when the server's answer is missing a value. */
export const FALLBACK_NATIVE_PDF_LIMITS: NativePdfLimits = {
  defaultBatchPages: NATIVE_PDF_MAX_PAGES,
  maxBatchPages: NATIVE_PDF_MAX_PAGES,
  maxDocumentPages: NATIVE_PDF_MAX_PAGES,
};

/**
 * Reads resolved feature limits into {@link NativePdfLimits} and puts them
 * in order: a batch cannot exceed the document total, nor the default the
 * largest batch. Values an admin saved out of order are lowered, never
 * raised.
 *
 * @param values - Limits by key, as the workflow policy resolved them.
 */
export function nativePdfLimits(
  values: Partial<Record<keyof NativePdfLimits, number>> | undefined,
): NativePdfLimits {
  const whole = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : fallback;
  const maxDocumentPages = whole(
    values?.maxDocumentPages,
    FALLBACK_NATIVE_PDF_LIMITS.maxDocumentPages,
  );
  const maxBatchPages = Math.min(
    whole(values?.maxBatchPages, FALLBACK_NATIVE_PDF_LIMITS.maxBatchPages),
    maxDocumentPages,
  );
  const defaultBatchPages = Math.min(
    whole(
      values?.defaultBatchPages,
      FALLBACK_NATIVE_PDF_LIMITS.defaultBatchPages,
    ),
    maxBatchPages,
  );
  return { defaultBatchPages, maxBatchPages, maxDocumentPages };
}

/**
 * Splits a batch's pages into the requests that will translate them, each
 * at most {@link NATIVE_PDF_MAX_PAGES} pages, in page order.
 *
 * @example splitIntoRequests([1, 2, 3, 4, 5, 6, 7]) // [[1..6], [7]]
 */
export function splitIntoRequests(
  pages: number[],
  perRequest: number = NATIVE_PDF_MAX_PAGES,
): number[][] {
  const size = Math.max(1, Math.floor(perRequest));
  const requests: number[][] = [];
  for (let index = 0; index < pages.length; index += size) {
    requests.push(pages.slice(index, index + size));
  }
  return requests;
}

/** Units one run may carry; beyond this the document needs batching. */
export const NATIVE_PDF_MAX_UNITS = 400;

/**
 * Longest translation accepted for one unit when a person edits it. A unit
 * is a paragraph at most; anything longer is not an edit of that unit.
 */
export const NATIVE_PDF_MAX_TRANSLATION_CHARS = 8_000;

export const NATIVE_PDF_MAX_REFIT_ROUNDS = 2;

/**
 * How thoroughly the translate step works. `quick` translates each page
 * once. `reviewed` then checks the draft against the source and revises it,
 * for up to {@link NATIVE_PDF_MAX_REVIEW_ROUNDS} rounds per page.
 */
export const NATIVE_PDF_DEPTHS = ['quick', 'reviewed'] as const;
export type NativePdfDepth = (typeof NATIVE_PDF_DEPTHS)[number];
export const NATIVE_PDF_DEFAULT_DEPTH: NativePdfDepth = 'quick';
export const NATIVE_PDF_MAX_REVIEW_ROUNDS = 3;

/** What a person can ask for on a single unit after a run. */
export const NATIVE_PDF_UNIT_ACTIONS = [
  'shorten',
  'change',
  'translate',
] as const;
export type NativePdfUnitAction = (typeof NATIVE_PDF_UNIT_ACTIONS)[number];
export const NATIVE_PDF_DEFAULT_REFIT_ROUNDS = 1;

/**
 * Scale below which a unit is sent back for a shorter translation. Compared
 * with {@link SCALE_EPSILON}: the engine reports 0.85 as 0.8500001 or
 * 0.8499999 depending on the font.
 */
export const REFIT_SCALE_THRESHOLD = 0.85;
export const SCALE_EPSILON = 1e-3;

/** How far a shortened translation aims below what would just fit. */
const REFIT_SAFETY = 0.95;
/** Shortening asked for when only a visual check, not a scale, flagged the unit. */
const VISUAL_ISSUE_SHORTEN_RATIO = 0.85;
/** Never ask for less than this share of the current length. */
const MIN_SHORTEN_RATIO = 0.5;

/**
 * Limits of the AUTOMATIC layout fixes (see planLayoutFixes). They are
 * tighter than what a person may set by hand: a fix nobody asked for must
 * stay small enough to be an obvious improvement or an obvious no-op.
 */
/** Smallest font an automatic fix sets, as a share of the source's size. */
export const AUTO_MIN_SIZE_RATIO = 0.7;
/** Farthest an automatic fix moves a unit along one axis, in points. */
export const AUTO_MAX_SHIFT = 48;
/** Range of a prescribed percentage (of the current size or length). */
export const AUTO_MIN_PERCENT = 50;
export const AUTO_MAX_PERCENT = 95;
/** Weight of a major finding against a minor one (see layoutScore). */
const MAJOR_ISSUE_WEIGHT = 10;

/** Fixes the visual check can prescribe for a finding. */
export const NATIVE_PDF_FIX_ACTIONS = [
  'none',
  'shorten',
  'smaller',
  'move',
] as const;
export type NativePdfFixAction = (typeof NATIVE_PDF_FIX_ACTIONS)[number];

/**
 * The fix the visual check prescribes for one finding.
 *  - `smaller`: `percent` is the new font size as a share of the size shown.
 *  - `shorten`: `percent` is the new length as a share of the current one.
 *  - `move`: `dx`, `dy` in page points, as in NativePdfUnitStyle (+x right,
 *    +y down).
 * Fields an action does not use are ignored.
 */
export interface NativePdfLayoutFix {
  action: NativePdfFixAction;
  percent: number;
  dx: number;
  dy: number;
}

export const NATIVE_PDF_ROLES = [
  'title',
  'heading',
  'body',
  'list_item',
  'table_header',
  'table_cell',
  'caption',
  'running_header',
  'running_footer',
  'label',
  'other',
] as const;
export type NativePdfRole = (typeof NATIVE_PDF_ROLES)[number];

export const NATIVE_PDF_ISSUE_KINDS = [
  'overflow',
  'overlap',
  'clipped',
  'low_contrast',
  'leftover_source',
  'misplaced',
  'too_small',
  'other',
] as const;
export type NativePdfIssueKind = (typeof NATIVE_PDF_ISSUE_KINDS)[number];

/** Issue kinds a shorter translation can cure. */
const FIT_ISSUE_KINDS: ReadonlySet<NativePdfIssueKind> = new Set([
  'overflow',
  'overlap',
  'clipped',
  'low_contrast',
  'too_small',
]);

export interface NativePdfTag {
  open: string;
  close: string;
}

/** One unit as the sandbox script reports it (see its docstring). */
export interface NativePdfUnit {
  id: string;
  page: number;
  /** Per-page label drawn on the page images. */
  n: number;
  /** Where the source text was measured. */
  bbox: [number, number, number, number];
  /** Where the translation may be laid out. */
  room: [number, number, number, number];
  /** The card, cell or box the unit sits inside, which its room stays in. */
  panel?: [number, number, number, number];
  /**
   * Names the units of the page set in the same style (the items of a
   * list, the headings of a row of cards). Peers are kept at one size.
   */
  peer?: string;
  /** How the source text is aligned; the translation is laid out the same. */
  align?: 'left' | 'center' | 'right';
  /** `room` area over `bbox` area: how much more space there is than was used. */
  roomFactor: number;
  lines: number;
  size: number;
  /** The unit's dominant text colour, as `#rrggbb`. */
  color?: string;
  text: string;
  tags: Record<string, NativePdfTag>;
  /** Visible characters of `text`, tags excluded. */
  chars: number;
}

export interface NativePdfPageStats {
  page: number;
  width: number;
  height: number;
  units: number;
  textChars: number;
  /** No text layer under a page-sized image: nothing to extract. */
  scanned: boolean;
}

export interface NativePdfFitReport {
  id: string;
  page: number;
  n: number;
  scale: number;
  fits: boolean;
  /** The part of its room the text took up, `[x0, y0, x1, y1]`. */
  used?: [number, number, number, number];
}

/** A step as it finished. */
export interface NativePdfStepRecord {
  id: NativePdfStepId;
  status: 'done' | 'skipped';
  durationMs: number;
  /** One line on what the step did, for the run's paper trail. */
  detail: string;
}

/** One unit of a finished run, as the workspace shows and edits it. */
export interface NativePdfUnitResult {
  id: string;
  page: number;
  n: number;
  role: NativePdfRole;
  note: string;
  source: string;
  /** Where the source text sits, in page points from the top-left corner. */
  bbox: NativePdfUnit['bbox'];
  /** Where a translation may be laid out, in the same coordinates. */
  room: NativePdfUnit['room'];
  /** Visible characters that fit the room at full size (see charBudget). */
  budgetChars: number;
  /** Font size of the source text in points; absent on runs made before it was kept. */
  size?: number;
  /** Colour of the source text as `#rrggbb`; absent as `size` is. */
  color?: string;
  /** Null when the unit was deliberately left as written. */
  translation: string | null;
  /** Layout scale of the final rebuild (1 = unshrunk); null when untouched. */
  scale: number | null;
  fits: boolean | null;
  /** The model's inline tags had to be repaired. */
  tagsRepaired: boolean;
  /** The translation was shortened in a refit round. */
  refitted: boolean;
}

/** Where one rebuilt page's images are served from. */
export interface NativePdfPageImages {
  page: number;
  /** PNG of the translated page. */
  previewUrl: string;
  /** PNG of the original beside the translated page. */
  checkUrl: string;
}

/** What a finished run sends the client. */
export interface NativePdfRunReport {
  steps: NativePdfStepRecord[];
  pageCount: number;
  pages: NativePdfPageStats[];
  units: NativePdfUnitResult[];
  /** Layout defects still present after the last round. */
  issues: NativePdfIssue[];
  /** Pages the layout check could not look at; they have no findings. */
  uncheckedPages: number[];
  fonts: { sans: string; serif: string };
  refitRounds: number;
  /**
   * Unit id to the look the automatic fixes gave it (a smaller font, a
   * move). The PDF is laid out with these; a re-render must send them back.
   */
  styles?: Record<string, NativePdfUnitStyle>;
  pdfUrl: string;
  pageImages: NativePdfPageImages[];
  /** Ids of the stored source PDF and extraction; a re-render sends them back. */
  sourceId: string;
  unitsId: string;
}

/** What a re-render sends the client. */
export interface NativePdfRenderReport {
  fits: NativePdfFitReport[];
  /** Findings for `checkedPages` only. */
  issues: NativePdfIssue[];
  checkedPages: number[];
  /** Pages a check was asked for and could not run on. */
  uncheckedPages: number[];
  fonts: { sans: string; serif: string };
  repaired: string[];
  tooLong: string[];
  pdfUrl: string;
  /** Images of the pages asked for only (`imagePages`), not of every page. */
  pageImages: NativePdfPageImages[];
  /**
   * The extraction this render used. When several were sent it is a new
   * one holding all of them; later re-renders send it alone.
   */
  unitsId: string;
}

/**
 * One line of a run's progress stream (newline-delimited JSON). A step is
 * announced `active` when it starts and again with its record when it ends;
 * the stream closes with exactly one `result` or `error`.
 */
export type NativePdfStreamEvent =
  | { type: 'step'; id: NativePdfStepId; status: 'active' }
  | ({ type: 'step' } & NativePdfStepRecord)
  | { type: 'result'; data: NativePdfRunReport }
  | { type: 'error'; message: string };

export interface NativePdfIssue {
  page: number;
  /** The unit's per-page label, or null for a page-level remark. */
  n: number | null;
  kind: NativePdfIssueKind;
  severity: 'minor' | 'major';
  note: string;
  /** What the check prescribes for it; absent on findings made without one. */
  fix?: NativePdfLayoutFix;
}

/**
 * Keeps only instructions for steps that accept them, trimmed and capped.
 * Anything else in the object is dropped rather than rejected, so a client
 * built against a newer step list still runs.
 *
 * @param value - Untrusted input (parsed JSON).
 */
export function sanitizeStepInstructions(
  value: unknown,
): NativePdfStepInstructions {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const clean: NativePdfStepInstructions = {};
  for (const step of NATIVE_PDF_STEPS) {
    if (!step.instructable) continue;
    const text = raw[step.id];
    if (typeof text !== 'string') continue;
    const trimmed = text.trim().slice(0, MAX_STEP_INSTRUCTION_CHARS);
    if (trimmed) clean[step.id] = trimmed;
  }
  return clean;
}

export type PageSelection =
  | { ok: true; pages: number[] }
  | { ok: false; error: string };

/**
 * Parses a page selection such as "1,8,21" or "2-4, 9".
 *
 * @param spec - The user's selection; empty means "from page 1".
 * @param maxPages - Most pages a run may hold.
 * @returns Sorted, de-duplicated 1-based page numbers, or why it was refused.
 * @example parsePageSelection('3, 1-2', 6) // { ok: true, pages: [1, 2, 3] }
 */
export function parsePageSelection(
  spec: string | null | undefined,
  maxPages: number = NATIVE_PDF_MAX_PAGES,
): PageSelection {
  const text = (spec ?? '').trim();
  if (!text) {
    return {
      ok: true,
      pages: Array.from({ length: maxPages }, (_, index) => index + 1),
    };
  }
  const pages = new Set<number>();
  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return { ok: false, error: `Unreadable page range: "${part}"` };
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (from < 1 || to < from) {
      return { ok: false, error: `Invalid page range: "${part.trim()}"` };
    }
    for (let page = from; page <= to; page += 1) {
      pages.add(page);
      if (pages.size > maxPages) {
        return {
          ok: false,
          error: `At most ${maxPages} pages can be translated in one run`,
        };
      }
    }
  }
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}

const TAG_PATTERN = /<(\/?)(g\d+|b|i)>/g;
const ANY_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;

/** Visible length of a unit's text: tags do not take up room on the page. */
export function visibleLength(text: string): number {
  return text.replace(ANY_TAG_PATTERN, '').length;
}

export interface TagRepair {
  text: string;
  /** True when the translation was changed to make its tags valid. */
  repaired: boolean;
}

/**
 * Makes a translation's inline tags valid against its source: tags the source
 * does not have are removed, a closer with no opener is removed, and an
 * opener never closed is closed at the end. Text is never altered.
 *
 * A model occasionally drops or invents a tag; an unbalanced one would
 * otherwise restyle the rest of the paragraph, or reach the page as literal
 * markup.
 *
 * @param source - The unit's source text, which defines the allowed tags.
 * @param translation - The model's translation of it.
 */
export function repairTranslationTags(
  source: string,
  translation: string,
): TagRepair {
  const allowed = new Set<string>();
  for (const match of source.matchAll(TAG_PATTERN)) allowed.add(match[2]);

  const open: string[] = [];
  let repaired = false;
  let text = translation.replace(ANY_TAG_PATTERN, (tag) => {
    const match = tag.match(/^<(\/?)(g\d+|b|i)>$/);
    if (!match || !allowed.has(match[2])) {
      repaired = true;
      return '';
    }
    const [, closing, name] = match;
    if (!closing) {
      open.push(name);
      return tag;
    }
    const index = open.lastIndexOf(name);
    if (index === -1) {
      repaired = true;
      return '';
    }
    open.splice(index, 1);
    return tag;
  });
  if (open.length > 0) {
    repaired = true;
    text += open
      .reverse()
      .map((name) => `</${name}>`)
      .join('');
  }
  return { text, repaired };
}

/**
 * Characters a unit's translation should aim for: its source length scaled by
 * the spare room around it. A guide for the translator, not a hard limit —
 * the layout step is what decides whether text fits.
 *
 * @param unit - The unit's source length and room factor.
 */
export function charBudget(
  unit: Pick<NativePdfUnit, 'chars' | 'roomFactor'>,
): number {
  const factor = Math.min(Math.max(unit.roomFactor, 1), 2);
  return Math.max(8, Math.round(unit.chars * factor));
}

export interface RefitTarget {
  id: string;
  /** Visible characters the shorter translation should not exceed. */
  targetChars: number;
  reason: 'scale' | 'visual';
}

/** What one round of automatic layout fixes will change. */
export interface LayoutFixPlan {
  /** Units going back for a shorter translation, and how short. */
  targets: RefitTarget[];
  /** Every unit's style after the round: the given ones plus the fixes. */
  styles: Record<string, NativePdfUnitStyle>;
  /** Ids of units set in a smaller font by this round. */
  resized: string[];
  /** Ids of units moved by this round. */
  moved: string[];
}

/** Whether a plan changes anything. */
export function hasLayoutFixes(plan: LayoutFixPlan): boolean {
  return (
    plan.targets.length > 0 || plan.resized.length > 0 || plan.moved.length > 0
  );
}

/** A value held inside a range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Decides one round of automatic layout fixes from the layout report and
 * the visual check.
 *
 * Per unit, in this order:
 *  - The layout could not fit it, or shrank it past
 *    {@link REFIT_SCALE_THRESHOLD}: a shorter translation, sized from how
 *    far it was shrunk.
 *  - The visual check prescribed a fix for it (NativePdfLayoutFix): that
 *    fix, held inside the automatic limits. A major finding is preferred
 *    over a minor one, and a move is made for a major finding only.
 *    `smaller` sets a font size counted from the size the
 *    text is SHOWN at (its size times the layout's shrink), never below
 *    {@link AUTO_MIN_SIZE_RATIO} of the source's; where that floor leaves
 *    nothing to take off, the unit is shortened instead. The size is given
 *    to the unit's peers on the page too (NativePdfUnit.peer).
 *  - The check raised a major fit issue without prescribing anything: a
 *    shorter translation.
 * Minor remarks without a prescription change nothing.
 *
 * @param input.fits - The layout report of the latest rebuild.
 * @param input.issues - The latest visual check's findings.
 * @param input.lengths - Visible length of each unit's current translation;
 *   a unit absent here is not translated and is never touched.
 * @param input.units - Source font size per unit; a unit absent here cannot
 *   be resized and is shortened instead.
 * @param input.styles - Styles already in force; never modified.
 */
export function planLayoutFixes(input: {
  fits: readonly NativePdfFitReport[];
  issues: readonly NativePdfIssue[];
  lengths: ReadonlyMap<string, number>;
  units?: readonly Pick<NativePdfUnit, 'id' | 'size' | 'peer'>[];
  styles?: Readonly<Record<string, NativePdfUnitStyle>>;
}): LayoutFixPlan {
  const sizeById = new Map(
    (input.units ?? []).map((unit) => [unit.id, unit.size]),
  );
  const peerById = new Map(
    (input.units ?? []).map((unit) => [unit.id, unit.peer]),
  );
  /** Sets a unit's font size and, so a list never mixes sizes, its peers'. */
  const resize = (fit: NativePdfFitReport, size: number): void => {
    const peer = peerById.get(fit.id);
    for (const other of input.fits) {
      const isPeer =
        other.id === fit.id ||
        (peer !== undefined &&
          other.page === fit.page &&
          peerById.get(other.id) === peer);
      const otherSize = sizeById.get(other.id);
      if (!isPeer || !otherSize || !input.lengths.get(other.id)) continue;
      const style = plan.styles[other.id] ?? {};
      // A peer already set smaller than this keeps its size.
      if ((style.size ?? otherSize) <= size + SCALE_EPSILON) continue;
      plan.styles[other.id] = { ...style, size };
      if (!plan.resized.includes(other.id)) plan.resized.push(other.id);
    }
  };
  const plan: LayoutFixPlan = {
    targets: [],
    styles: { ...(input.styles ?? {}) },
    resized: [],
    moved: [],
  };
  const shorten = (
    id: string,
    length: number,
    ratio: number,
    reason: RefitTarget['reason'],
  ): void => {
    plan.targets.push({
      id,
      targetChars: Math.max(
        4,
        Math.floor(length * Math.max(ratio, MIN_SHORTEN_RATIO)),
      ),
      reason,
    });
  };
  for (const fit of input.fits) {
    const length = input.lengths.get(fit.id);
    if (!length) continue;
    if (!fit.fits || fit.scale < REFIT_SCALE_THRESHOLD - SCALE_EPSILON) {
      shorten(fit.id, length, fit.scale * REFIT_SAFETY, 'scale');
      continue;
    }
    const found = input.issues.filter(
      (issue) => issue.page === fit.page && issue.n === fit.n,
    );
    const prescribed = [...found]
      .sort(
        (a, b) =>
          Number(b.severity === 'major') - Number(a.severity === 'major'),
      )
      .find((issue) => issue.fix && issue.fix.action !== 'none');
    const fix = prescribed?.fix;
    if (!fix) {
      const majorFit = found.some(
        (issue) =>
          !issue.fix &&
          issue.severity === 'major' &&
          FIT_ISSUE_KINDS.has(issue.kind),
      );
      if (majorFit) {
        shorten(fit.id, length, VISUAL_ISSUE_SHORTEN_RATIO, 'visual');
      }
      continue;
    }
    const style = plan.styles[fit.id] ?? {};
    if (fix.action === 'move') {
      // Nudging one item of a list for a minor remark unsettles its rhythm
      // more than the remark was worth.
      if (prescribed?.severity !== 'major') continue;
      const dx = clamp(fix.dx, -AUTO_MAX_SHIFT, AUTO_MAX_SHIFT);
      const dy = clamp(fix.dy, -AUTO_MAX_SHIFT, AUTO_MAX_SHIFT);
      const moved = sanitizeUnitStyle({
        ...style,
        dx: (style.dx ?? 0) + dx,
        dy: (style.dy ?? 0) + dy,
      });
      if (
        (moved?.dx ?? 0) !== (style.dx ?? 0) ||
        (moved?.dy ?? 0) !== (style.dy ?? 0)
      ) {
        if (moved) plan.styles[fit.id] = moved;
        else delete plan.styles[fit.id];
        plan.moved.push(fit.id);
      }
      continue;
    }
    const ratio = clamp(fix.percent, AUTO_MIN_PERCENT, AUTO_MAX_PERCENT) / 100;
    const sourceSize = sizeById.get(fit.id);
    if (fix.action === 'smaller' && sourceSize) {
      const current = style.size ?? sourceSize;
      const shown = current * Math.min(fit.scale, 1);
      const floor = Math.max(
        sourceSize * AUTO_MIN_SIZE_RATIO,
        NATIVE_PDF_MIN_FONT_SIZE,
      );
      // Rounded down to a size a person could also have set by hand.
      const next =
        Math.floor(Math.max(shown * ratio, floor) / NATIVE_PDF_FONT_SIZE_STEP) *
        NATIVE_PDF_FONT_SIZE_STEP;
      if (next >= floor - SCALE_EPSILON && next < current - SCALE_EPSILON) {
        resize(fit, next);
        continue;
      }
    }
    // A shortening, or a resize the floor leaves no room for.
    shorten(
      fit.id,
      length,
      fix.action === 'shorten' ? ratio : VISUAL_ISSUE_SHORTEN_RATIO,
      'visual',
    );
  }
  return plan;
}

/**
 * Decides which units go back for a shorter translation, and how short,
 * when shortening is the only fix on offer (see {@link planLayoutFixes},
 * whose rules these are with no prescriptions and no styles).
 *
 * @param fits - The layout report of the latest rebuild.
 * @param issues - The latest visual check's findings.
 * @param currentLength - Visible length of each unit's current translation.
 */
export function selectRefitTargets(
  fits: readonly NativePdfFitReport[],
  issues: readonly NativePdfIssue[],
  currentLength: ReadonlyMap<string, number>,
): RefitTarget[] {
  return planLayoutFixes({
    fits,
    issues: issues.map((issue) => ({ ...issue, fix: undefined })),
    lengths: currentLength,
  }).targets;
}

/**
 * How bad a page's layout is, for telling whether a round of fixes helped:
 * higher is worse. A major finding outweighs any number of minor ones a
 * page plausibly has, and a unit the layout could not fit counts as major.
 *
 * @param fits - The page's layout report.
 * @param issues - The page's findings.
 */
export function layoutScore(
  fits: readonly NativePdfFitReport[],
  issues: readonly NativePdfIssue[],
): number {
  const unfit = fits.filter(
    (fit) => !fit.fits || fit.scale < REFIT_SCALE_THRESHOLD - SCALE_EPSILON,
  ).length;
  const major = issues.filter((issue) => issue.severity === 'major').length;
  return (unfit + major) * MAJOR_ISSUE_WEIGHT + (issues.length - major);
}

/**
 * How a person changed the look of one unit's translation. Every field is
 * optional; an absent one keeps what the source has.
 *
 * Convention, stated once: `dx` and `dy` move the area the translation is
 * laid out in, in page points, in the same coordinates as `bbox` and
 * `room`: +x is right, +y is DOWN.
 */
export interface NativePdfUnitStyle {
  /** Font size in points. */
  size?: number;
  /** Text colour as lowercase `#rrggbb`. */
  color?: string;
  dx?: number;
  dy?: number;
}

/** Font sizes a person may set, in points. */
export const NATIVE_PDF_MIN_FONT_SIZE = 4;
export const NATIVE_PDF_MAX_FONT_SIZE = 96;
/** One press of a size button, in points. */
export const NATIVE_PDF_FONT_SIZE_STEP = 0.5;
/**
 * Farthest a unit may be moved along one axis, in points. The layout also
 * keeps the unit on its page; this bounds the number itself.
 */
export const NATIVE_PDF_MAX_SHIFT = 2000;
/** One press of a move button, in points. */
export const NATIVE_PDF_SHIFT_STEP = 2;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A number held inside a range, or undefined when it is not a number. */
function boundedNumber(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  // Two decimals: finer than anything a page shows, and stable to compare.
  return Math.round(Math.min(Math.max(value, min), max) * 100) / 100;
}

/**
 * One style with only its valid, meaningful fields: numbers inside their
 * ranges, a colour in `#rrggbb`, and no zero move.
 *
 * @param value - Untrusted input.
 * @returns The style, or undefined when nothing of it is left.
 */
export function sanitizeUnitStyle(
  value: unknown,
): NativePdfUnitStyle | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const style: NativePdfUnitStyle = {};
  const size = boundedNumber(
    raw.size,
    NATIVE_PDF_MIN_FONT_SIZE,
    NATIVE_PDF_MAX_FONT_SIZE,
  );
  if (size !== undefined) style.size = size;
  const color = typeof raw.color === 'string' ? raw.color.toLowerCase() : '';
  if (HEX_COLOR.test(color)) style.color = color;
  for (const axis of ['dx', 'dy'] as const) {
    const shift = boundedNumber(
      raw[axis],
      -NATIVE_PDF_MAX_SHIFT,
      NATIVE_PDF_MAX_SHIFT,
    );
    if (shift) style[axis] = shift;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * The styles a client sends for a re-render, as they are laid out. As with
 * {@link sanitizeTranslationEdits} the client is not trusted: only units of
 * this document keep a style, and each style is passed through
 * {@link sanitizeUnitStyle} (the colour reaches a style sheet).
 *
 * @param value - Untrusted input: an object of unit id to style.
 * @param units - The document's units, as extracted.
 * @returns Unit id to style, for the units that have one.
 */
export function sanitizeUnitStyles(
  value: unknown,
  units: Pick<NativePdfUnit, 'id'>[],
): Record<string, NativePdfUnitStyle> {
  const styles: Record<string, NativePdfUnitStyle> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return styles;
  }
  const raw = value as Record<string, unknown>;
  for (const unit of units) {
    const style = sanitizeUnitStyle(raw[unit.id]);
    if (style) styles[unit.id] = style;
  }
  return styles;
}

/** Translations ready to lay out, after {@link sanitizeTranslationEdits}. */
export interface NativePdfTranslationSet {
  /** Unit id to the text to lay out. A unit without an entry stays as written. */
  translations: Map<string, string>;
  /** Units whose inline tags had to be repaired. */
  repaired: string[];
  /** Units refused for exceeding {@link NATIVE_PDF_MAX_TRANSLATION_CHARS}. */
  tooLong: string[];
}

/**
 * Turns the translations a client sends for a re-render into the set that is
 * laid out. The client's view is never trusted: an id that is not a unit of
 * this document is dropped, tags are checked against the unit's own source
 * (see the numbered-tag convention above), and an over-long text is refused
 * and reported instead of being cut, since cutting would silently change
 * what the person wrote.
 *
 * `null`, an empty string or a missing id all mean "keep this unit as
 * written".
 *
 * @param value - Untrusted input: an object of unit id to text or null.
 * @param units - The document's units, as extracted.
 * @returns The translations to lay out and what was repaired or refused.
 */
export function sanitizeTranslationEdits(
  value: unknown,
  units: Pick<NativePdfUnit, 'id' | 'text'>[],
): NativePdfTranslationSet {
  const result: NativePdfTranslationSet = {
    translations: new Map(),
    repaired: [],
    tooLong: [],
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }
  const raw = value as Record<string, unknown>;
  for (const unit of units) {
    const text = raw[unit.id];
    if (typeof text !== 'string' || !text.trim()) continue;
    if (text.length > NATIVE_PDF_MAX_TRANSLATION_CHARS) {
      result.tooLong.push(unit.id);
      continue;
    }
    const fixed = repairTranslationTags(unit.text, text.trim());
    if (!fixed.text.trim()) continue;
    if (fixed.repaired) result.repaired.push(unit.id);
    result.translations.set(unit.id, fixed.text);
  }
  return result;
}
