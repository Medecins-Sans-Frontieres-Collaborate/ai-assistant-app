import { buildGlossaryBlock } from '@/lib/services/workflows/shared/glossaryPrompts';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveVisionWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { mergeGlossaryEntries } from '@/lib/utils/shared/translation/glossaryMatch';
import { findTranslationLanguageByLabel } from '@/lib/utils/shared/translation/languages';
import { NativeSourceFormat } from '@/lib/utils/shared/translation/nativeFormats';
import {
  MAX_BRIEF_TERMS,
  NATIVE_PDF_MAX_REVIEW_ROUNDS,
  NATIVE_PDF_MAX_UNITS,
  NATIVE_PDF_STEPS,
  NativePdfBrief,
  NativePdfDepth,
  NativePdfExportFormat,
  NativePdfFitReport,
  NativePdfIssue,
  NativePdfIssueKind,
  NativePdfLanguage,
  NativePdfLayoutFix,
  NativePdfPageStats,
  NativePdfRole,
  NativePdfStepId,
  NativePdfStepInstructions,
  NativePdfStepRecord,
  NativePdfTerm,
  NativePdfUnit,
  NativePdfUnitAction,
  NativePdfUnitResult,
  NativePdfUnitStyle,
  addsAbbreviation,
  breakLike,
  charBudget,
  dropsTerm,
  hasLayoutFixes,
  layoutScore,
  mergeBriefs,
  missingTerms,
  planLayoutFixes,
  repairTranslationTags,
  sanitizeBrief,
  sanitizeLanguageCode,
  sanitizeTranslationEdits,
  sanitizeUnitStyles,
  termCandidates,
  termKey,
  termsIn,
  visibleLength,
  wordingInCaseOf,
} from '@/lib/utils/shared/translation/nativePdf';

import { GlossaryEntry } from '@/types/workflow';

import { nativeFormatAdapter } from './formats';
import {
  FormatCallContext,
  NativeFormatAdapter,
  NativePdfPageOutput,
} from './formats/nativeFormat';
import {
  ANALYZE_SCHEMA,
  LANGUAGE_PROMPT,
  LANGUAGE_SCHEMA,
  REVIEW_PROMPT,
  REVIEW_SCHEMA,
  SHORTEN_PROMPT,
  TERMS_REPAIR_PROMPT,
  TERMS_SCHEMA,
  TRANSLATE_SCHEMA,
  UNIT_CHANGE_PROMPT,
  UNIT_TEXT_SCHEMA,
  VERIFY_SCHEMA,
  buildStepPrompt,
  buildTermsPrompt,
  targetLanguageLines,
} from './nativePdfPrompts';

import { strFromU8, strToU8 } from 'fflate';
import type { AzureOpenAI } from 'openai';

/**
 * Native PDF translation: a fixed sequence of steps that turns a PDF into a
 * translated PDF with the same pages, using only the platform's existing
 * capabilities (code interpreter, vision, text models).
 *
 *   extract   sandbox   text units with geometry and styling, labelled page images
 *   analyze   vision    each unit's role, and what must not be translated
 *   translate text      one structured call per page, with a length budget per unit
 *   rebuild   sandbox   source text removed, translations laid out in its place
 *   verify    vision    original beside translated, layout defects reported
 *   refit     text      what the check prescribed (shorter wording, a smaller font, a move),
 *                       then rebuild and verify again; a page made worse is put back
 *
 * Every step runs on every call, in that order (see NATIVE_PDF_STEPS). The
 * caller can add instructions to the model steps; it cannot skip a step.
 * Each rebuild starts from the ORIGINAL document, so rounds never compound.
 *
 * Never fabricates: a page with no text layer, or a run with nothing to
 * translate, fails with a reason instead of returning an unchanged file.
 */

export type { NativePdfPageOutput } from './formats/nativeFormat';

export interface NativePdfParams {
  /** The original file's bytes. */
  document: Buffer;
  /** What the original is (THE FORMAT ADAPTER); a PDF when absent. */
  format?: NativeSourceFormat;
  /** Presentations: whether speaker notes are translated too. */
  translateNotes?: boolean;
  /** Told how many jobs are ahead while a step waits for a render slot. */
  onQueue?: (ahead: number) => void;
  targetLanguage: string;
  /** 1-based pages to translate (see parsePageSelection). */
  pages: number[];
  instructions: NativePdfStepInstructions;
  /** Model for the text and vision steps (already resolved and eligible). */
  modelId: string;
  /** Refit rounds allowed after the first verify. */
  maxRefitRounds: number;
  /** Whether the translate step also reviews and revises its draft. */
  depth: NativePdfDepth;
  /** Terminology the translation must follow; only terms on a page are sent. */
  glossaryEntries: GlossaryEntry[];
  /**
   * What earlier requests for this document settled (THE DOCUMENT BRIEF in
   * nativePdf.ts), already sanitized. Absent on a document's first request.
   */
  brief?: NativePdfBrief;
  /** Called when a step starts (`active`) and when it ends (its record). */
  onStep?: (
    event: { id: NativePdfStepId; status: 'active' } | NativePdfStepRecord,
  ) => void;
  /** Aborts the run between model and sandbox calls. */
  signal?: AbortSignal;
  usage: WorkflowUsageCollector;
}

export interface NativePdfResult {
  steps: NativePdfStepRecord[];
  pageCount: number;
  pages: NativePdfPageStats[];
  units: NativePdfUnitResult[];
  /** Layout defects still present after the last round. */
  issues: NativePdfIssue[];
  /** Pages the layout check could not look at. */
  uncheckedPages: number[];
  fonts: { sans: string; serif: string };
  refitRounds: number;
  /** Unit id to the look the automatic fixes gave it; the PDF uses these. */
  styles: Record<string, NativePdfUnitStyle>;
  /** The brief this run was given, with what it decided added. */
  brief: NativePdfBrief;
  /** The translated pages as a PDF; null when a presentation could not be rendered. */
  pdf: Uint8Array | null;
  /** Sources that are not PDF: the translated file in its own format. */
  document?: Uint8Array;
  outputs: NativePdfPageOutput[];
  /**
   * The extraction as the sandbox wrote it. Kept so the pages can be laid
   * out again with edited translations (see rerenderNativePdf) without
   * repeating the extract step.
   */
  unitsFile: Uint8Array;
}

export interface NativePdfRerenderParams {
  /** The original file's bytes. */
  document: Buffer;
  /** What the original is (THE FORMAT ADAPTER); a PDF when absent. */
  format?: NativeSourceFormat;
  /** Told how many jobs are ahead while the render waits for a slot. */
  onQueue?: (ahead: number) => void;
  signal?: AbortSignal;
  /**
   * The extractions of the document's batches, oldest first: one for a
   * single batch, several when batches are being put together.
   */
  unitsFiles: Uint8Array[];
  /**
   * Pages to return images of; absent means every translated page. The
   * pages in `checkPages` are always included.
   */
  imagePages?: number[];
  /**
   * Source pages (1-based) to leave out of the PDF. Their translations are
   * still laid out, so putting a page back needs nothing but another render.
   */
  omitPages?: number[];
  /** Untrusted: unit id to the person's style for it (see NativePdfUnitStyle). */
  styles?: unknown;
  /** Untrusted: the target language's tag, which selects hyphenation rules. */
  language?: unknown;
  /** Editable formats to build beside the PDF, already sanitized. */
  exports?: NativePdfExportFormat[];
  /** Most pages of the document that may carry a translation. */
  maxDocumentPages: number;
  /** Untrusted: unit id to translation; null or absent keeps the unit as written. */
  translations: unknown;
  /** Pages to run the layout check on afterwards; empty skips the check. */
  checkPages: number[];
  instructions: NativePdfStepInstructions;
  modelId: string;
  usage: WorkflowUsageCollector;
}

export interface NativePdfRerenderResult {
  fits: NativePdfFitReport[];
  /** Findings for `checkPages` only. */
  issues: NativePdfIssue[];
  checkedPages: number[];
  /** Pages a check was asked for and could not run on. */
  uncheckedPages: number[];
  fonts: { sans: string; serif: string };
  /** Units whose inline tags had to be repaired. */
  repaired: string[];
  /** Units refused as too long; they were laid out as written. */
  tooLong: string[];
  /** Null when a presentation could not be rendered. */
  pdf: Uint8Array | null;
  /** Sources that are not PDF: the translated file in its own format. */
  document?: Uint8Array;
  /** The editable files asked for, by format. */
  exports: Partial<Record<NativePdfExportFormat, Uint8Array>>;
  outputs: NativePdfPageOutput[];
  /** The extraction that was laid out: the only one sent, or all combined. */
  unitsFile: Uint8Array;
}

/** Thrown when a re-render would translate more pages than the limit. */
export class NativePdfDocumentLimitError extends Error {
  constructor(
    readonly pages: number,
    readonly limit: number,
  ) {
    super(
      `This document already has translations on ${pages} pages; at most ${limit} pages of one document can be translated`,
    );
    this.name = 'NativePdfDocumentLimitError';
  }
}

/** Thrown when a re-render is asked to leave every page out of the result. */
export class NativePdfNoPagesLeftError extends Error {
  constructor() {
    super('At least one page has to stay in the document');
    this.name = 'NativePdfNoPagesLeftError';
  }
}

interface ExtractPayload {
  pageCount: number;
  pages: NativePdfPageStats[];
  units: NativePdfUnit[];
}

interface UnitAnalysis {
  role: NativePdfRole;
  translate: boolean;
  note: string;
}

/** Characters of a unit's text shown to the vision model beside the image. */
const ANALYZE_TEXT_PREVIEW_CHARS = 160;
const TRANSLATE_MAX_TOKENS = 12_000;
const VISION_MAX_TOKENS = 4_000;
const LANGUAGE_MAX_TOKENS = 1_000;
/** Earlier decisions shown when new terms are decided: the latest ones. */
const DECIDED_TERMS_SHOWN = 80;
/** Units one request may ask to have reworded to the brief's terms. */
const TERM_REPAIRS_MAX = 80;

const pngDataUrl = (bytes: Uint8Array): string =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

function groupByPage<T extends { page: number }>(items: T[]): Map<number, T[]> {
  const pages = new Map<number, T[]>();
  for (const item of items) {
    pages.set(item.page, [...(pages.get(item.page) ?? []), item]);
  }
  return pages;
}

/** One page's units classified from its labelled image. */
async function analyzePage(options: {
  client: AzureOpenAI;
  model: string;
  system: string;
  /**
   * The labelled picture of the page; null when it could not be made (a
   * presentation whose slides could not be rendered): the units are then
   * judged from their text alone.
   */
  image: Uint8Array | null;
  units: NativePdfUnit[];
  usage: WorkflowUsageCollector;
}): Promise<{
  notes: string;
  names: string[];
  byNumber: Map<number, UnitAnalysis>;
}> {
  const listing = options.units.map((unit) => ({
    n: unit.n,
    size: unit.size,
    text: unit.text
      .replace(/<[^>]+>/g, '')
      .slice(0, ANALYZE_TEXT_PREVIEW_CHARS),
  }));
  const result = await callStructured<{
    pageNotes: string;
    names: string[];
    units: Array<UnitAnalysis & { n: number }>;
  }>({
    client: options.client,
    model: options.model,
    system: options.system,
    user: [
      { type: 'text', text: `Units on this page:\n${JSON.stringify(listing)}` },
      ...(options.image
        ? [
            {
              type: 'image_url' as const,
              image_url: {
                url: pngDataUrl(options.image),
                detail: 'high' as const,
              },
            },
          ]
        : []),
    ],
    schemaName: 'native_pdf_page_analysis',
    schema: ANALYZE_SCHEMA,
    maxTokens: VISION_MAX_TOKENS,
    usage: options.usage,
    usageLabel: 'native-pdf-analyze',
  });
  return {
    notes: result.pageNotes,
    names: result.names ?? [],
    byNumber: new Map(result.units.map((unit) => [unit.n, unit])),
  };
}

/**
 * Pins the target language down for the whole document (THE DOCUMENT BRIEF
 * in nativePdf.ts). A language from the list is known by its label and
 * costs nothing; one a person typed in is identified by the model, which
 * also settles the variety and spelling when the name leaves them open.
 *
 * @returns The language; with an empty code and note when the model could
 *   not be asked, so a run never fails for want of this.
 */
async function resolveLanguage(options: {
  client: AzureOpenAI;
  model: string;
  targetLanguage: string;
  usage: WorkflowUsageCollector;
}): Promise<NativePdfLanguage> {
  const listed = findTranslationLanguageByLabel(options.targetLanguage);
  if (listed) return { code: listed.id, name: listed.name, note: '' };
  try {
    const found = await callStructured<NativePdfLanguage>({
      client: options.client,
      model: options.model,
      system: LANGUAGE_PROMPT,
      user: `Target language as typed: ${options.targetLanguage}`,
      schemaName: 'native_pdf_language',
      schema: LANGUAGE_SCHEMA,
      maxTokens: LANGUAGE_MAX_TOKENS,
      usage: options.usage,
      usageLabel: 'native-pdf-language',
    });
    const language = sanitizeBrief({ language: found }).language;
    if (language) return language;
  } catch (error) {
    console.warn('[native-pdf] Could not identify the target language:', error);
  }
  return { code: '', name: options.targetLanguage, note: '' };
}

/**
 * Decides, once for the document, how each new name or recurring term is
 * handled: kept as written or translated, and then as what.
 *
 * @param options.candidates - Names not yet in the brief, as written.
 * @param options.decided - The brief's terms, shown so new decisions follow
 *   their pattern.
 * @returns The decisions for candidates the model answered; a candidate it
 *   skipped, or all of them when the call fails, stays undecided and is
 *   handled page by page as before.
 */
async function decideTerms(options: {
  client: AzureOpenAI;
  model: string;
  system: string;
  language: string;
  candidates: string[];
  decided: NativePdfTerm[];
  usage: WorkflowUsageCollector;
}): Promise<NativePdfTerm[]> {
  if (options.candidates.length === 0) return [];
  try {
    const result = await callStructured<{ terms: NativePdfTerm[] }>({
      client: options.client,
      model: options.model,
      system: options.system,
      user: [
        options.language,
        `Already decided:\n${JSON.stringify(options.decided.slice(-DECIDED_TERMS_SHOWN))}`,
        `Candidates:\n${JSON.stringify(options.candidates)}`,
      ].join('\n\n'),
      schemaName: 'native_pdf_terms',
      schema: TERMS_SCHEMA,
      maxTokens: TRANSLATE_MAX_TOKENS,
      usage: options.usage,
      usageLabel: 'native-pdf-terms',
    });
    const asked = new Set(options.candidates.map(termKey));
    return sanitizeBrief({ terms: result.terms }).terms.filter((term) =>
      asked.has(termKey(term.source)),
    );
  } catch (error) {
    console.warn('[native-pdf] Could not decide the document terms:', error);
    return [];
  }
}

/** A brief's terms as glossary rows: a kept term's translation is itself. */
function termsAsGlossary(terms: NativePdfTerm[]): GlossaryEntry[] {
  return terms.map((term) => ({
    source: term.source,
    target: term.target,
    note: term.keep
      ? 'name: keep exactly as written'
      : 'fixed for this document: use on every page',
  }));
}

/** One page's translatable units translated in a single structured call. */
async function translatePage(options: {
  client: AzureOpenAI;
  model: string;
  system: string;
  /** How the step is told the target language (targetLanguageLines). */
  language: string;
  notes: string;
  units: NativePdfUnit[];
  analysis: Map<string, UnitAnalysis>;
  glossaryEntries: GlossaryEntry[];
  /** Review rounds to run on the draft; 0 translates once. */
  reviewRounds: number;
  signal?: AbortSignal;
  usage: WorkflowUsageCollector;
}): Promise<{ translations: Map<string, string>; revised: Set<string> }> {
  if (options.units.length === 0) {
    return { translations: new Map(), revised: new Set() };
  }
  // Only the terms that occur on this page are sent (buildGlossaryBlock).
  const glossaryBlock = buildGlossaryBlock(
    options.glossaryEntries,
    options.units.map((unit) => unit.text).join('\n'),
  );
  const payload = options.units.map((unit) => ({
    id: unit.id,
    role: options.analysis.get(unit.id)?.role ?? 'other',
    note: options.analysis.get(unit.id)?.note ?? '',
    budgetChars: charBudget(unit),
    text: unit.text,
  }));
  const result = await callStructured<{
    units: Array<{ id: string; text: string }>;
  }>({
    client: options.client,
    model: options.model,
    system: options.system + glossaryBlock,
    user: [
      options.language,
      `About this page: ${options.notes || 'no notes'}`,
      `Units:\n${JSON.stringify(payload)}`,
    ].join('\n\n'),
    schemaName: 'native_pdf_translation',
    schema: TRANSLATE_SCHEMA,
    maxTokens: TRANSLATE_MAX_TOKENS,
    usage: options.usage,
    usageLabel: 'native-pdf-translate',
  });
  const known = new Set(options.units.map((unit) => unit.id));
  const translations = new Map(
    result.units
      .filter((unit) => known.has(unit.id))
      .map((unit) => [unit.id, unit.text]),
  );
  const revised = new Set<string>();
  for (let round = 0; round < options.reviewRounds; round += 1) {
    options.signal?.throwIfAborted();
    const review = await callStructured<{
      approved: boolean;
      units: Array<{ id: string; text: string }>;
    }>({
      client: options.client,
      model: options.model,
      system: REVIEW_PROMPT + glossaryBlock,
      user: [
        options.language,
        `About this page: ${options.notes || 'no notes'}`,
        `Units:\n${JSON.stringify(
          payload.map((unit) => ({
            id: unit.id,
            role: unit.role,
            budgetChars: unit.budgetChars,
            source: unit.text,
            draft: translations.get(unit.id) ?? '',
          })),
        )}`,
      ].join('\n\n'),
      schemaName: 'native_pdf_review',
      schema: REVIEW_SCHEMA,
      maxTokens: TRANSLATE_MAX_TOKENS,
      usage: options.usage,
      usageLabel: 'native-pdf-review',
    });
    // A "correction" identical to the draft is not a change.
    const changes = review.units.filter(
      (unit) =>
        known.has(unit.id) &&
        unit.text.trim() &&
        unit.text.trim() !== (translations.get(unit.id) ?? '').trim(),
    );
    if (review.approved || changes.length === 0) break;
    for (const unit of changes) {
      translations.set(unit.id, unit.text);
      revised.add(unit.id);
    }
  }
  return { translations, revised };
}

/** One page's layout defects, read from the original-beside-translated image. */
async function verifyPage(options: {
  client: AzureOpenAI;
  model: string;
  system: string;
  page: number;
  check: Uint8Array;
  /** Per-page labels of units deliberately left as written. */
  kept: number[];
  /** The page's size and its units' measurements, for prescribing fixes. */
  facts: string;
  usage: WorkflowUsageCollector;
}): Promise<NativePdfIssue[]> {
  const result = await callStructured<{
    issues: Array<{
      n: number | null;
      kind: NativePdfIssueKind;
      severity: 'minor' | 'major';
      note: string;
      fix: NativePdfLayoutFix;
    }>;
  }>({
    client: options.client,
    model: options.model,
    system: options.system,
    user: [
      {
        type: 'text',
        text: [
          'Original (left) and translated (right).',
          // Without this the check reports every kept name as untranslated.
          options.kept.length > 0
            ? `Units left in the source language on purpose (names, codes, figures); their text being unchanged is correct: ${options.kept.join(', ')}.`
            : 'Every unit on this page was meant to be translated.',
          options.facts,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        type: 'image_url',
        image_url: { url: pngDataUrl(options.check), detail: 'high' },
      },
    ],
    schemaName: 'native_pdf_page_check',
    schema: VERIFY_SCHEMA,
    maxTokens: VISION_MAX_TOKENS,
    usage: options.usage,
    usageLabel: 'native-pdf-verify',
  });
  return result.issues.map((issue) => ({ ...issue, page: options.page }));
}

/**
 * What the check is told about a page besides its picture: the page's size
 * and each laid-out unit's font size, shrink and area, in points. Without
 * these a prescribed move or size has nothing to be measured against.
 *
 * @returns The lines to add to the check's message; empty when the page's
 *   size or layout report is not known.
 */
function checkFacts(options: {
  page: number;
  pages?: NativePdfPageStats[];
  units: NativePdfUnit[];
  fits?: NativePdfFitReport[];
  styles?: Record<string, NativePdfUnitStyle>;
}): string {
  const stats = options.pages?.find((entry) => entry.page === options.page);
  const fits = (options.fits ?? []).filter((fit) => fit.page === options.page);
  if (!stats || fits.length === 0) return '';
  const unitById = new Map(options.units.map((unit) => [unit.id, unit]));
  const box = (values: number[]) => values.map(Math.round).join(', ');
  const lines = fits.flatMap((fit) => {
    const unit = unitById.get(fit.id);
    if (!unit) return [];
    const size = options.styles?.[fit.id]?.size ?? unit.size;
    return [
      `${fit.n}: ${size} pt` +
        (fit.scale < 1 ? `, shrunk to ${Math.round(fit.scale * 100)}%` : '') +
        (fit.used ? `, text takes up [${box(fit.used)}]` : '') +
        (unit.panel ? `, inside a box at [${box(unit.panel)}]` : ''),
    ];
  });
  return [
    `The page is ${stats.width} by ${stats.height} points. Areas are [left, top, right, bottom] from the top-left corner.`,
    `Units as laid out:\n${lines.join('\n')}`,
  ].join('\n');
}

/** What a rebuild returns besides the translated pages themselves. */
export interface NativePdfUnitRevision {
  action: NativePdfUnitAction;
  targetLanguage: string;
  /** The document brief's language, so the block matches its pages. */
  language?: NativePdfLanguage;
  /** The unit's source text, with its inline tags. */
  source: string;
  /** The current translation; ignored by `translate`. */
  translation: string;
  /** What to change, for `change`. */
  instruction: string;
  /** Visible length to aim for, for `shorten`. */
  targetChars: number;
  glossaryEntries: GlossaryEntry[];
  modelId: string;
  usage: WorkflowUsageCollector;
}

/**
 * Rewrites the translation of a single unit at a person's request: a
 * shorter wording, a change described in words, or a first translation of a
 * unit that had been left as written. Nothing is laid out; the caller
 * re-renders when ready.
 *
 * @param params - The unit's texts and what is asked for.
 * @returns The new text, with tags checked against the source, and whether
 *   they had to be repaired.
 * @throws Error when the model returns no text.
 */
export async function reviseNativeUnit(
  params: NativePdfUnitRevision,
): Promise<{ text: string; repaired: boolean }> {
  const glossaryBlock = buildGlossaryBlock(
    params.glossaryEntries,
    params.source,
  );
  const shared = {
    client: createAzureClient(),
    model: params.modelId,
    maxTokens: VISION_MAX_TOKENS,
    usage: params.usage,
    usageLabel: `native-pdf-unit-${params.action}`,
  };
  let text: string;
  if (params.action === 'shorten') {
    const result = await callStructured<{
      units: Array<{ id: string; text: string }>;
    }>({
      ...shared,
      system: SHORTEN_PROMPT,
      user: [
        targetLanguageLines(params.targetLanguage, params.language),
        `Units:\n${JSON.stringify([
          {
            id: 'unit',
            targetChars: params.targetChars,
            text: params.translation,
          },
        ])}`,
      ].join('\n\n'),
      schemaName: 'native_pdf_shorten',
      schema: TRANSLATE_SCHEMA,
    });
    text = result.units[0]?.text ?? '';
  } else if (params.action === 'translate') {
    const result = await callStructured<{
      units: Array<{ id: string; text: string }>;
    }>({
      ...shared,
      system: buildStepPrompt('translate', {}) + glossaryBlock,
      user: [
        targetLanguageLines(params.targetLanguage, params.language),
        `Units:\n${JSON.stringify([
          {
            id: 'unit',
            role: 'other',
            note: '',
            budgetChars: params.targetChars,
            text: params.source,
          },
        ])}`,
      ].join('\n\n'),
      schemaName: 'native_pdf_translation',
      schema: TRANSLATE_SCHEMA,
    });
    text = result.units[0]?.text ?? '';
  } else {
    const result = await callStructured<{ text: string }>({
      ...shared,
      system: UNIT_CHANGE_PROMPT + glossaryBlock,
      user: [
        targetLanguageLines(params.targetLanguage, params.language),
        `Source: ${params.source}`,
        `Translation: ${params.translation}`,
        `Request: ${params.instruction}`,
      ].join('\n\n'),
      schemaName: 'native_pdf_unit_change',
      schema: UNIT_TEXT_SCHEMA,
    });
    text = result.text;
  }
  if (!text.trim())
    throw new Error('The model returned no text for this block');
  return repairTranslationTags(params.source, text.trim());
}

/** Findings of a layout check, and the pages it could not look at. */
interface LayoutCheck {
  issues: NativePdfIssue[];
  checkedPages: number[];
  /** Pages whose check failed, e.g. on a dropped connection. */
  uncheckedPages: number[];
}

/**
 * Runs the layout check on each given page and gathers the findings.
 *
 * The check is advice about pages that are already built, so a page whose
 * check fails is reported as unchecked instead of failing the run and
 * discarding the pages with it. Only a stop request is passed on.
 */
async function verifyPages(options: {
  client: AzureOpenAI;
  model: string;
  instructions: NativePdfStepInstructions;
  outputs: NativePdfPageOutput[];
  /** Every unit of the document, to tell which were left as written. */
  units: NativePdfUnit[];
  /** Ids of the units that were laid out translated. */
  translated: ReadonlySet<string>;
  /** Page sizes, the layout report and the styles in force (see checkFacts). */
  pages?: NativePdfPageStats[];
  fits?: NativePdfFitReport[];
  styles?: Record<string, NativePdfUnitStyle>;
  usage: WorkflowUsageCollector;
  signal?: AbortSignal;
}): Promise<LayoutCheck> {
  const system = buildStepPrompt('verify', options.instructions);
  const perPage = await Promise.allSettled(
    options.outputs.map((output) =>
      verifyPage({
        client: options.client,
        model: options.model,
        system,
        page: output.page,
        check: output.check,
        kept: options.units
          .filter(
            (unit) =>
              unit.page === output.page && !options.translated.has(unit.id),
          )
          .map((unit) => unit.n),
        facts: checkFacts({ ...options, page: output.page }),
        usage: options.usage,
      }),
    ),
  );
  options.signal?.throwIfAborted();
  const check: LayoutCheck = {
    issues: [],
    checkedPages: [],
    uncheckedPages: [],
  };
  perPage.forEach((outcome, index) => {
    const page = options.outputs[index].page;
    if (outcome.status === 'fulfilled') {
      check.issues.push(...outcome.value);
      check.checkedPages.push(page);
    } else {
      console.warn(
        `[nativePdf] Layout check failed for page ${page}:`,
        outcome.reason,
      );
      check.uncheckedPages.push(page);
    }
  });
  return check;
}

/**
 * Puts the extractions of several batches of ONE document together. Where
 * two hold the same page, the later one's units and page record replace the
 * earlier one's entirely: a page translated again is laid out from its
 * newest extraction only.
 *
 * @param files - The extractions as stored, oldest first; at least one.
 * @returns One extraction in page order, as bytes ready to store or upload.
 * @throws Error when a file is not a readable extraction.
 */
export function combineExtractions(files: Uint8Array[]): Uint8Array {
  const parsed = files.map((file) => {
    let payload: ExtractPayload;
    try {
      payload = JSON.parse(strFromU8(file)) as ExtractPayload;
    } catch {
      throw new Error('The stored extraction for this document is unreadable');
    }
    if (!Array.isArray(payload.units) || !Array.isArray(payload.pages)) {
      throw new Error('The stored extraction for this document is unreadable');
    }
    return payload;
  });
  if (parsed.length === 1) return files[0];
  const pages = new Map<number, NativePdfPageStats>();
  const units = new Map<number, NativePdfUnit[]>();
  for (const payload of parsed) {
    const held = new Set(payload.pages.map((page) => page.page));
    for (const page of payload.pages) pages.set(page.page, page);
    for (const page of held) units.set(page, []);
    for (const unit of payload.units) {
      if (!units.has(unit.page)) units.set(unit.page, []);
      units.get(unit.page)?.push(unit);
    }
  }
  const order = [...units.keys()].sort((a, b) => a - b);
  const combined: ExtractPayload = {
    pageCount: parsed[0].pageCount,
    pages: [...pages.values()].sort((a, b) => a.page - b.page),
    units: order.flatMap((page) => units.get(page) ?? []),
  };
  return strToU8(JSON.stringify(combined));
}

/**
 * Lays a run's pages out again with translations a person has edited.
 *
 * Only the rebuild step runs, plus the layout check on the pages asked for:
 * nothing is re-extracted or re-translated. Like every rebuild it starts
 * from the original document, so repeated edits never compound.
 *
 * @param params - The original PDF, the run's extraction and the
 *   translations as the client now has them.
 * @returns The new PDF and page images, each unit's fit, and the findings
 *   for the checked pages.
 * @throws NativePdfDocumentLimitError when more pages would carry a
 *   translation than `maxDocumentPages`.
 * @throws NativePdfNoPagesLeftError when `omitPages` names every page.
 * @throws Error when the extraction cannot be read, no unit is left with a
 *   translation, or the sandbox step fails.
 */
export async function rerenderNativePdf(
  params: NativePdfRerenderParams,
): Promise<NativePdfRerenderResult> {
  const unitsFile = combineExtractions(params.unitsFiles);
  const extracted = JSON.parse(strFromU8(unitsFile)) as ExtractPayload;
  const edits = sanitizeTranslationEdits(params.translations, extracted.units);
  if (edits.translations.size === 0) {
    throw new Error('No translated text was given to lay out');
  }
  const translatedPages = new Set(
    extracted.units
      .filter((unit) => edits.translations.has(unit.id))
      .map((unit) => unit.page),
  );
  if (translatedPages.size > params.maxDocumentPages) {
    throw new NativePdfDocumentLimitError(
      translatedPages.size,
      params.maxDocumentPages,
    );
  }
  const omitted = [...new Set(params.omitPages ?? [])].filter(
    (page) => page <= extracted.pageCount,
  );
  if (extracted.pageCount > 0 && omitted.length >= extracted.pageCount) {
    throw new NativePdfNoPagesLeftError();
  }
  const styles = sanitizeUnitStyles(params.styles, extracted.units);
  const adapter = nativeFormatAdapter(params.format ?? 'pdf');
  const built = await adapter.rebuild(
    params.document,
    unitsFile,
    edits.translations,
    {
      imagePages: params.imagePages && [
        ...new Set([...params.imagePages, ...params.checkPages]),
      ],
      omitPages: omitted,
      styles,
      language: sanitizeLanguageCode(params.language),
      exports: params.exports,
    },
    { usage: params.usage, signal: params.signal, onQueue: params.onQueue },
  );
  const wanted = new Set(params.checkPages);
  const toCheck = built.outputs.filter((output) => wanted.has(output.page));
  const check: LayoutCheck =
    toCheck.length === 0
      ? { issues: [], checkedPages: [], uncheckedPages: [] }
      : await verifyPages({
          client: createAzureClient(),
          model: resolveVisionWorkflowModelId(params.modelId),
          instructions: params.instructions,
          outputs: toCheck,
          units: extracted.units,
          translated: new Set(edits.translations.keys()),
          pages: extracted.pages,
          fits: built.fits,
          styles,
          usage: params.usage,
        });
  return {
    fits: built.fits,
    // The prescriptions are for the automatic rounds of a first run.
    issues: check.issues.map(({ fix: _fix, ...issue }) => issue),
    checkedPages: check.checkedPages,
    uncheckedPages: [
      ...new Set([
        ...check.uncheckedPages,
        ...(built.unpictured ?? []).filter((page) => wanted.has(page)),
      ]),
    ],
    fonts: built.fonts,
    repaired: edits.repaired,
    tooLong: edits.tooLong,
    pdf: built.pdf,
    ...(built.document ? { document: built.document } : {}),
    exports: built.exports,
    outputs: built.outputs,
    unitsFile,
  };
}

/**
 * Runs the native PDF translation pipeline on the selected pages.
 *
 * @param params - The document, target language, pages and step additions.
 * @returns The translated PDF, per-page images, and a record of every step,
 *   unit and remaining layout issue.
 * @throws Error when the selected pages hold no extractable text (scanned
 *   pages), hold more units than one run allows, or a step fails.
 */
export async function runNativePdfTranslation(
  params: NativePdfParams,
): Promise<NativePdfResult> {
  const { document, targetLanguage, instructions, usage } = params;
  const adapter: NativeFormatAdapter = nativeFormatAdapter(
    params.format ?? 'pdf',
  );
  const context: FormatCallContext = {
    usage,
    signal: params.signal,
    onQueue: params.onQueue,
  };
  const client = createAzureClient();
  const visionModel = resolveVisionWorkflowModelId(params.modelId);
  const steps: NativePdfStepRecord[] = [];
  const record = (
    id: NativePdfStepId,
    startedAt: number,
    detail: string,
    status: NativePdfStepRecord['status'] = 'done',
  ) => {
    const step = { id, status, durationMs: Date.now() - startedAt, detail };
    steps.push(step);
    params.onStep?.(step);
  };
  /** Marks a step as started; returns its start time. */
  const begin = (id: NativePdfStepId): number => {
    params.signal?.throwIfAborted();
    params.onStep?.({ id, status: 'active' });
    return Date.now();
  };

  // ── extract ────────────────────────────────────────────────────────────
  let startedAt = begin('extract');
  const extraction = await adapter.extract(document, params.pages, {
    ...context,
    translateNotes: params.translateNotes,
  });
  const unitsFile = extraction.unitsFile;
  const extracted = JSON.parse(strFromU8(unitsFile)) as ExtractPayload;
  const scannedPages = extracted.pages.filter((page) => page.scanned);
  record(
    'extract',
    startedAt,
    `${extracted.units.length} text units on ${extracted.pages.length} of ${extracted.pageCount} pages` +
      (scannedPages.length
        ? `; no text layer on page ${scannedPages.map((p) => p.page).join(', ')}`
        : ''),
  );
  if (extracted.units.length === 0) {
    throw new Error(
      scannedPages.length > 0
        ? 'The selected pages are scanned images with no text layer, which this pipeline cannot translate'
        : 'No text was found on the selected pages',
    );
  }
  if (extracted.units.length > NATIVE_PDF_MAX_UNITS) {
    throw new Error(
      `The selected pages hold ${extracted.units.length} text units; one run handles at most ${NATIVE_PDF_MAX_UNITS}. Select fewer pages`,
    );
  }
  const unitsByPage = groupByPage(extracted.units);
  const unitById = new Map(extracted.units.map((unit) => [unit.id, unit]));

  // ── analyze ────────────────────────────────────────────────────────────
  startedAt = begin('analyze');
  const analysis = new Map<string, UnitAnalysis>();
  const pageNotes = new Map<number, string>();
  const namesFound: string[] = [];
  // The brief's language stands; only a document's first request settles it.
  const languageSettled: Promise<NativePdfLanguage> = params.brief?.language
    ? Promise.resolve(params.brief.language)
    : resolveLanguage({
        client,
        model: params.modelId,
        targetLanguage,
        usage,
      });
  await Promise.all(
    [...unitsByPage].map(async ([page, units]) => {
      const result = await analyzePage({
        client,
        model: visionModel,
        system: buildStepPrompt('analyze', instructions),
        image: extraction.pageImage(page),
        units,
        usage,
      });
      pageNotes.set(page, result.notes);
      namesFound.push(...result.names);
      for (const unit of units) {
        // A unit the model skipped is translated: leaving text untranslated
        // must be a decision, never an omission.
        analysis.set(
          unit.id,
          result.byNumber.get(unit.n) ?? {
            role: 'other',
            translate: true,
            note: '',
          },
        );
      }
    }),
  );
  // A unit repeated across pages (a running header) gets one decision: it is
  // translated everywhere if any page's reading said to translate it.
  const translateByText = new Map<string, boolean>();
  for (const unit of extracted.units) {
    const decided = analysis.get(unit.id)?.translate !== false;
    translateByText.set(
      unit.text,
      (translateByText.get(unit.text) ?? false) || decided,
    );
  }
  for (const unit of extracted.units) {
    const info = analysis.get(unit.id);
    if (info) info.translate = translateByText.get(unit.text) ?? true;
  }
  // THE DOCUMENT BRIEF: one decision per name for every page and request.
  // Whatever a page's reading listed as a name, or left as written, is
  // decided here unless the brief or the glossary already says.
  const language = await languageSettled;
  const languageLines = targetLanguageLines(targetLanguage, language);
  const candidates = termCandidates(
    [
      ...namesFound,
      ...extracted.units
        .filter((unit) => analysis.get(unit.id)?.translate === false)
        .map((unit) => unit.text),
    ],
    [
      ...(params.brief?.terms ?? []).map((term) => term.source),
      ...params.glossaryEntries.map((entry) => entry.source),
    ],
    MAX_BRIEF_TERMS - (params.brief?.terms.length ?? 0),
  );
  const brief = mergeBriefs(params.brief, {
    language,
    terms: await decideTerms({
      client,
      model: params.modelId,
      system: buildTermsPrompt(instructions.analyze),
      language: languageLines,
      candidates,
      decided: params.brief?.terms ?? [],
      usage,
    }),
  });
  // A glossary entry outranks the brief on the same term.
  const glossaryEntries = mergeGlossaryEntries(
    params.glossaryEntries,
    termsAsGlossary(brief.terms),
  );
  const glossarySources = new Set(
    params.glossaryEntries.map((entry) => termKey(entry.source)),
  );
  const termByKey = new Map(
    brief.terms
      .filter((term) => !glossarySources.has(termKey(term.source)))
      .map((term) => [termKey(term.source), term]),
  );
  /** The brief's term a unit consists of entirely, if it is one. */
  const termOf = (unit: NativePdfUnit): NativePdfTerm | undefined =>
    termByKey.get(termKey(unit.text));
  for (const unit of extracted.units) {
    const term = termOf(unit);
    const info = analysis.get(unit.id);
    if (term && info) info.translate = !term.keep;
  }
  const kept = extracted.units.filter(
    (unit) => analysis.get(unit.id)?.translate === false,
  );
  record(
    'analyze',
    startedAt,
    `${extracted.units.length - kept.length} units to translate, ${kept.length} kept as written` +
      `; ${brief.terms.length} names and terms fixed for the document` +
      (language.note ? `; writing in: ${language.note}` : ''),
  );

  // ── translate ──────────────────────────────────────────────────────────
  startedAt = begin('translate');
  const translations = new Map<string, string>();
  const repaired = new Set<string>();
  const reviewRevised = new Set<string>();
  const accept = (id: string, text: string): void => {
    const unit = unitById.get(id);
    // An id the model invented, or an empty translation, is ignored: the
    // unit then keeps its source text and is reported as untranslated.
    if (!unit || !text.trim()) return;
    const fixed = repairTranslationTags(unit.text, text.trim());
    if (fixed.repaired) repaired.add(id);
    translations.set(id, fixed.text);
  };
  await Promise.all(
    [...unitsByPage].map(async ([page, units]) => {
      const translated = await translatePage({
        client,
        model: params.modelId,
        system: buildStepPrompt('translate', instructions),
        language: languageLines,
        notes: pageNotes.get(page) ?? '',
        units: units.filter(
          (unit) => analysis.get(unit.id)?.translate !== false,
        ),
        analysis,
        glossaryEntries,
        reviewRounds:
          params.depth === 'reviewed' ? NATIVE_PDF_MAX_REVIEW_ROUNDS : 0,
        signal: params.signal,
        usage,
      });
      for (const [id, text] of translated.translations) accept(id, text);
      for (const id of translated.revised) reviewRevised.add(id);
    }),
  );
  if (translations.size === 0) {
    throw new Error('The translation step returned no translated units');
  }
  // Pages are translated independently, so a repeated unit can come back
  // worded two ways. The first page's wording is used for every repeat.
  const wordingByText = new Map<string, string>();
  for (const unit of extracted.units) {
    const translation = translations.get(unit.id);
    if (!translation) continue;
    const first = wordingByText.get(unit.text);
    if (first === undefined) wordingByText.set(unit.text, translation);
    else translations.set(unit.id, first);
  }
  // A unit that is nothing but one of the brief's translated terms reads as
  // the brief says on every page, whatever this page's translator wrote.
  // One with inline tags is left to the translator, who keeps the tags.
  const fixedWording = new Set<string>();
  for (const unit of extracted.units) {
    const term = termOf(unit);
    if (!term || term.keep || !translations.has(unit.id)) continue;
    fixedWording.add(unit.id);
    if (Object.keys(unit.tags).length === 0) {
      const worded = wordingInCaseOf(unit.text, term.target);
      // A term is matched across line breaks, but the breaks are the
      // unit's own (BREAKS in the layout script): the wording takes them
      // where this page's translator put them, else where the source has
      // them.
      const translated = translations.get(unit.id) ?? '';
      const breaks = (text: string) => text.split('\n').length - 1;
      const lineModel =
        breaks(translated) === breaks(unit.text) ? translated : unit.text;
      translations.set(
        unit.id,
        breaks(unit.text) > 0 ? breakLike(lineModel, worded) : worded,
      );
    }
  }
  // A term inside a longer unit is the translator's to write, and it does
  // not always follow the brief. Those units are asked for again, once,
  // and the answer is taken only where it then follows every term.
  const offTerm = extracted.units
    .filter((unit) => !fixedWording.has(unit.id))
    .map((unit) => ({
      unit,
      terms: missingTerms(
        unit.text,
        translations.get(unit.id) ?? unit.text,
        brief.terms,
      ),
    }))
    .filter((entry) => translations.has(entry.unit.id) && entry.terms.length)
    .slice(0, TERM_REPAIRS_MAX);
  let termsRepaired = 0;
  if (offTerm.length > 0) {
    params.signal?.throwIfAborted();
    const reworded = await callStructured<{
      units: Array<{ id: string; text: string }>;
    }>({
      client,
      model: params.modelId,
      system: TERMS_REPAIR_PROMPT,
      user: [
        languageLines,
        `Units:\n${JSON.stringify(
          offTerm.map(({ unit, terms }) => ({
            id: unit.id,
            source: unit.text,
            text: translations.get(unit.id),
            terms: terms.map(({ source, target }) => ({ source, target })),
          })),
        )}`,
      ].join('\n\n'),
      schemaName: 'native_pdf_terms_repair',
      schema: TRANSLATE_SCHEMA,
      maxTokens: TRANSLATE_MAX_TOKENS,
      usage,
      usageLabel: 'native-pdf-terms',
    });
    const sourceById = new Map(offTerm.map(({ unit }) => [unit.id, unit.text]));
    for (const unit of reworded.units) {
      const source = sourceById.get(unit.id);
      if (
        source !== undefined &&
        missingTerms(source, unit.text, brief.terms).length === 0
      ) {
        accept(unit.id, unit.text);
        termsRepaired += 1;
      }
    }
  }
  const missing = extracted.units.length - kept.length - translations.size;
  record(
    'translate',
    startedAt,
    `${translations.size} units translated into ${targetLanguage}` +
      (params.depth === 'reviewed'
        ? `; ${reviewRevised.size} revised in review`
        : '') +
      (repaired.size ? `; inline tags repaired in ${repaired.size}` : '') +
      (offTerm.length
        ? `; ${termsRepaired} of ${offTerm.length} reworded to the document's terms`
        : '') +
      (missing > 0 ? `; ${missing} returned no translation` : ''),
  );

  // ── rebuild ────────────────────────────────────────────────────────────
  startedAt = begin('rebuild');
  let built = await adapter.rebuild(
    document,
    unitsFile,
    translations,
    { language: language.code },
    context,
  );
  // A unit whose part could not be rewritten stays as in the source: it is
  // reported as not translated rather than as a translation nobody sees.
  const keptAsWritten = built.fits.filter((fit) => fit.kept);
  for (const fit of keptAsWritten) translations.delete(fit.id);
  const shrunk = (fits: NativePdfFitReport[]): number =>
    fits.filter((fit) => !fit.fits || fit.scale < 1).length;
  record(
    'rebuild',
    startedAt,
    `${built.fits.length} units laid out in ${built.fonts.sans}; ${shrunk(built.fits)} needed shrinking` +
      (keptAsWritten.length
        ? `; ${keptAsWritten.length} could not be written and stay as in the source`
        : ''),
  );

  // ── verify ─────────────────────────────────────────────────────────────
  startedAt = begin('verify');
  const verify = (
    outputs: NativePdfPageOutput[],
    styles: Record<string, NativePdfUnitStyle> = {},
  ) =>
    verifyPages({
      client,
      model: visionModel,
      instructions,
      outputs,
      units: extracted.units,
      translated: new Set(translations.keys()),
      pages: extracted.pages,
      fits: built.fits,
      styles,
      usage,
      signal: params.signal,
    });
  const firstCheck = await verify(built.outputs);
  let issues = firstCheck.issues;
  // Pages the rebuild could not picture (a presentation whose render
  // failed) could not be looked at either.
  const unchecked = new Set([
    ...firstCheck.uncheckedPages,
    ...(built.unpictured ?? []),
  ]);
  record(
    'verify',
    startedAt,
    `${issues.length} layout issues reported (${issues.filter((i) => i.severity === 'major').length} major)` +
      (unchecked.size > 0
        ? `; the check could not run for ${unchecked.size} page${unchecked.size > 1 ? 's' : ''}`
        : ''),
  );

  // ── refit ──────────────────────────────────────────────────────────────
  // Each round takes the check's prescriptions (a shorter wording, a smaller
  // font, a move), lays the pages out again and looks at the changed ones
  // again. A page a round made worse is put back as it was and left alone.
  startedAt = begin('refit');
  const firstTranslations = new Map(translations);
  let styles: Record<string, NativePdfUnitStyle> = {};
  const undonePages = new Set<number>();
  let rounds = 0;
  while (rounds < params.maxRefitRounds) {
    const lengths = new Map(
      [...translations].map(([id, text]) => [id, visibleLength(text)]),
    );
    const plan = planLayoutFixes({
      fits: built.fits.filter((fit) => !undonePages.has(fit.page)),
      issues: issues.filter((issue) => !undonePages.has(issue.page)),
      lengths,
      units: extracted.units,
      styles,
    });
    // A term the brief fixed is never reworded: it would then differ from
    // the same term on another page. It is set smaller instead.
    plan.targets = plan.targets.filter(
      (target) => !fixedWording.has(target.id),
    );
    if (!hasLayoutFixes(plan)) break;
    params.signal?.throwIfAborted();
    rounds += 1;
    const before = {
      translations: new Map(translations),
      styles,
      issues,
      fits: built.fits,
    };
    if (plan.targets.length > 0) {
      const shortened = await callStructured<{
        units: Array<{ id: string; text: string }>;
      }>({
        client,
        model: params.modelId,
        system: SHORTEN_PROMPT,
        user: [
          languageLines,
          `Units:\n${JSON.stringify(
            plan.targets.map((target) => {
              const text = translations.get(target.id) ?? '';
              const source = unitById.get(target.id)?.text ?? '';
              const unmet = new Set(missingTerms(source, text, brief.terms));
              const due = termsIn(source, brief.terms).filter(
                (term) => !unmet.has(term),
              );
              return {
                id: target.id,
                targetChars: target.targetChars,
                text,
                // The brief's wordings this text follows, to be kept.
                ...(due.length
                  ? { fixed: due.map((term) => term.target) }
                  : {}),
              };
            }),
          )}`,
        ].join('\n\n'),
        schemaName: 'native_pdf_shorten',
        schema: TRANSLATE_SCHEMA,
        maxTokens: TRANSLATE_MAX_TOKENS,
        usage,
        usageLabel: 'native-pdf-refit',
      });
      const wanted = new Set(plan.targets.map((target) => target.id));
      for (const unit of shortened.units) {
        // A shortening that abbreviates, or that loses one of the brief's
        // terms, is refused: the unit keeps its full wording, set smaller.
        const current = translations.get(unit.id) ?? '';
        const source = unitById.get(unit.id)?.text ?? '';
        if (
          wanted.has(unit.id) &&
          !addsAbbreviation(current, unit.text) &&
          !dropsTerm(source, current, unit.text, brief.terms)
        ) {
          accept(unit.id, unit.text);
        }
      }
    }
    styles = plan.styles;
    built = await adapter.rebuild(
      document,
      unitsFile,
      translations,
      { styles, language: language.code },
      context,
    );
    // Only the pages that changed are looked at again; the rest keep their findings.
    const changedPages = new Set(
      [
        ...plan.targets.map((target) => target.id),
        ...plan.resized,
        ...plan.moved,
      ].map((id) => unitById.get(id)?.page),
    );
    const rechecked = await verify(
      built.outputs.filter((output) => changedPages.has(output.page)),
      styles,
    );
    // A page whose recheck failed shows changed text: its old findings no
    // longer describe it, so they go and the page counts as unchecked.
    issues = [
      ...issues.filter((issue) => !changedPages.has(issue.page)),
      ...rechecked.issues,
    ];
    rechecked.checkedPages.forEach((page) => unchecked.delete(page));
    rechecked.uncheckedPages.forEach((page) => unchecked.add(page));
    built.unpictured?.forEach((page) => unchecked.add(page));
    // Do no harm: a page that reads worse than before the round goes back.
    const scoreOf = (
      page: number,
      state: { fits: NativePdfFitReport[]; issues: NativePdfIssue[] },
    ): number =>
      layoutScore(
        state.fits.filter((fit) => fit.page === page),
        state.issues.filter((issue) => issue.page === page),
      );
    const worse = new Set(
      rechecked.checkedPages.filter(
        (page) =>
          scoreOf(page, { fits: built.fits, issues }) > scoreOf(page, before),
      ),
    );
    if (worse.size > 0) {
      const restored = { ...styles };
      for (const unit of extracted.units) {
        if (!worse.has(unit.page)) continue;
        const text = before.translations.get(unit.id);
        if (text === undefined) translations.delete(unit.id);
        else translations.set(unit.id, text);
        if (before.styles[unit.id]) restored[unit.id] = before.styles[unit.id];
        else delete restored[unit.id];
      }
      styles = restored;
      issues = [
        ...issues.filter((issue) => !worse.has(issue.page)),
        ...before.issues.filter((issue) => worse.has(issue.page)),
      ];
      worse.forEach((page) => undonePages.add(page));
      // The pages on file still show the undone fixes.
      built = await adapter.rebuild(
        document,
        unitsFile,
        translations,
        { styles, language: language.code },
        context,
      );
    }
  }
  const refitted = new Set(
    [...translations]
      .filter(([id, text]) => firstTranslations.get(id) !== text)
      .map(([id]) => id),
  );
  const count = (field: keyof NativePdfUnitStyle): number =>
    Object.values(styles).filter((style) => style[field] !== undefined).length;
  const resizedCount = count('size');
  const movedCount = Object.values(styles).filter(
    (style) => style.dx !== undefined || style.dy !== undefined,
  ).length;
  const changes = [
    refitted.size > 0 ? `${refitted.size} shortened` : '',
    resizedCount > 0 ? `${resizedCount} set smaller` : '',
    movedCount > 0 ? `${movedCount} moved` : '',
  ].filter(Boolean);
  record(
    'refit',
    startedAt,
    rounds === 0
      ? 'Nothing needed adjusting'
      : `${changes.length > 0 ? `Units ${changes.join(', ')}` : 'No fix kept'} over ${rounds} round${rounds > 1 ? 's' : ''}` +
          (undonePages.size > 0
            ? `; fixes undone on page ${[...undonePages].sort((a, b) => a - b).join(', ')} where they made things worse`
            : '') +
          `; ${issues.length} issues remain`,
    rounds === 0 ? 'skipped' : 'done',
  );

  if (steps.length !== NATIVE_PDF_STEPS.length) {
    throw new Error('Native PDF pipeline finished without running every step');
  }

  const fitById = new Map(built.fits.map((fit) => [fit.id, fit]));
  return {
    steps,
    pageCount: extracted.pageCount,
    pages: extracted.pages,
    units: extracted.units.map((unit) => {
      const fit = fitById.get(unit.id);
      const info = analysis.get(unit.id);
      return {
        id: unit.id,
        page: unit.page,
        n: unit.n,
        role: info?.role ?? 'other',
        note: info?.note ?? '',
        source: unit.text,
        bbox: unit.bbox,
        room: unit.room,
        budgetChars: charBudget(unit),
        size: unit.size,
        ...(unit.color ? { color: unit.color } : {}),
        translation: translations.get(unit.id) ?? null,
        scale: fit?.scale ?? null,
        fits: fit?.fits ?? null,
        tagsRepaired: repaired.has(unit.id),
        refitted: refitted.has(unit.id),
      };
    }),
    // A prescription is for the fix rounds; what is reported is the finding.
    issues: issues.map(({ fix: _fix, ...issue }) => issue),
    uncheckedPages: [...unchecked].sort((a, b) => a - b),
    fonts: built.fonts,
    refitRounds: rounds,
    styles,
    brief,
    pdf: built.pdf,
    ...(built.document ? { document: built.document } : {}),
    outputs: built.outputs,
    unitsFile,
  };
}
