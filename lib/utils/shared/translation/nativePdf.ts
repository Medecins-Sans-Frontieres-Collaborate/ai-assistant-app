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

/** Pages one synchronous run may process: it bounds cost and request time. */
export const NATIVE_PDF_MAX_PAGES = 6;

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
  /** `room` area over `bbox` area: how much more space there is than was used. */
  roomFactor: number;
  lines: number;
  size: number;
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
  pageImages: NativePdfPageImages[];
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

/**
 * Decides which units go back for a shorter translation, and how short.
 *
 * A unit is refitted when the layout step could not fit it, shrank it past
 * {@link REFIT_SCALE_THRESHOLD}, or a visual check raised a major fit issue
 * on it. Minor remarks and issues that shortening cannot cure are reported
 * but do not trigger a refit.
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
  const flagged = new Set(
    issues
      .filter(
        (issue) =>
          issue.n !== null &&
          issue.severity === 'major' &&
          FIT_ISSUE_KINDS.has(issue.kind),
      )
      .map((issue) => `${issue.page}:${issue.n}`),
  );
  const targets: RefitTarget[] = [];
  for (const fit of fits) {
    const length = currentLength.get(fit.id);
    if (!length) continue;
    const tooSmall =
      !fit.fits || fit.scale < REFIT_SCALE_THRESHOLD - SCALE_EPSILON;
    const visual = flagged.has(`${fit.page}:${fit.n}`);
    if (!tooSmall && !visual) continue;
    const ratio = tooSmall
      ? fit.scale * REFIT_SAFETY
      : VISUAL_ISSUE_SHORTEN_RATIO;
    targets.push({
      id: fit.id,
      targetChars: Math.max(
        4,
        Math.floor(length * Math.max(ratio, MIN_SHORTEN_RATIO)),
      ),
      reason: tooSmall ? 'scale' : 'visual',
    });
  }
  return targets;
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
