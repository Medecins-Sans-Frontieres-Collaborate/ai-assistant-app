/**
 * Pure rules of the Translation workspace's whole-document mode: when it is
 * available, which step a job is on, and how the page reader shares the
 * translation pane with the text modes.
 *
 * PANE OWNERSHIP CONVENTION: the workspace works on one translation at a
 * time, held in `finalText` (with its `assessment`). In `document` mode the
 * reader puts the page in view there, so editing, quality assessment and
 * suggested edits work on a page exactly as they do on pasted text. Whatever
 * the text modes had produced is set aside in `textModeResult` the moment
 * the reader takes the pane (`showDocumentPage`) and put back when the user
 * leaves the mode (`leaveDocumentReader`). `documentJob.viewPage` says
 * whether, and for which page, the reader holds the pane.
 */
import { supportsPagedText } from '@/types/documentTranslation';
import {
  TranslationDocumentJob,
  TranslationSourceDocument,
  TranslationWorkflowState,
} from '@/types/workflow';

import { getDocumentTranslationLanguageByCode } from '@/lib/constants/documentTranslationLanguages';

/** Polling backoff for a running job, by time since it was submitted. */
export function pendingPollInterval(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 2 * 60_000) return 5_000;
  if (elapsedMs < 10 * 60_000) return 15_000;
  return 30_000;
}

/** Lowercase extension of a filename without the dot; '' when it has none. */
export function fileExtensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** Why whole-document translation cannot start. */
export type WholeDocumentBlocker =
  | 'no-document'
  | 'unsupported-format'
  | 'no-language'
  | 'unsupported-language';

/** Whether a whole-document translation can start, and with what. */
export type WholeDocumentEligibility =
  | { ok: true; languageCode: string; document: TranslationSourceDocument }
  | { ok: false; reason: WholeDocumentBlocker };

/**
 * Decides whether the uploaded document can be translated whole.
 *
 * It needs a file kept on the server, in a format with a page-by-page text
 * view, and a target language that document translation supports (custom
 * languages and some catalog languages are language-model only).
 *
 * @param sourceDocument - The uploaded document's reference, if any.
 * @param targetLanguageId - Id of the workspace's target language, if set.
 */
export function wholeDocumentEligibility(
  sourceDocument: TranslationSourceDocument | undefined,
  targetLanguageId: string | undefined,
): WholeDocumentEligibility {
  if (!sourceDocument?.url) return { ok: false, reason: 'no-document' };
  if (!supportsPagedText(fileExtensionOf(sourceDocument.name))) {
    return { ok: false, reason: 'unsupported-format' };
  }
  if (!targetLanguageId) return { ok: false, reason: 'no-language' };
  const language = getDocumentTranslationLanguageByCode(targetLanguageId);
  if (!language) return { ok: false, reason: 'unsupported-language' };
  return { ok: true, languageCode: language.code, document: sourceDocument };
}

/** Steps of a whole-document job, in the order they happen. */
export const DOCUMENT_JOB_STEPS = [
  'uploaded',
  'translating',
  'preparing',
  'ready',
] as const;

/** A step of a whole-document job. */
export type DocumentJobStep = (typeof DOCUMENT_JOB_STEPS)[number];

/** The step in progress for a job that has not failed. */
export function documentJobStep(
  status: Exclude<TranslationDocumentJob['status'], 'failed'>,
): DocumentJobStep {
  return status;
}

/**
 * Clamps a page number to the document.
 *
 * @param page - Requested 1-based page; fractions are floored.
 * @param pageCount - Pages in the document, when known.
 */
export function clampPage(page: number, pageCount?: number): number {
  const whole = Number.isFinite(page) ? Math.floor(page) : 1;
  const upper = pageCount && pageCount > 0 ? pageCount : Infinity;
  return Math.min(Math.max(whole, 1), upper);
}

/**
 * Parses a page number typed by the user.
 *
 * @returns The page, or undefined when the input is not a whole number
 *   inside the document.
 */
export function parsePageInput(
  input: string,
  pageCount?: number,
): number | undefined {
  if (!/^\s*\d+\s*$/.test(input)) return undefined;
  const page = Number(input);
  return page === clampPage(page, pageCount) ? page : undefined;
}

/**
 * What to store as the correction for a page.
 *
 * @param text - The page's text as the user has it now.
 * @param machineTranslation - The page's unedited translation.
 * @returns The text to save, or null when it matches the machine
 *   translation again (ignoring surrounding whitespace) and the correction
 *   should be removed.
 */
export function correctionToSave(
  text: string,
  machineTranslation: string,
): string | null {
  return text.trim() === machineTranslation.trim() ? null : text;
}

type PaneState = Pick<
  TranslationWorkflowState,
  'finalText' | 'assessment' | 'textModeResult' | 'documentJob'
>;

/**
 * Puts a page of the document in the translation pane.
 *
 * The first time the reader takes the pane, the text-mode result is set
 * aside (see the pane ownership convention). The page's assessment starts
 * empty: suggestions belong to the page they were made for.
 *
 * @param state - Current workflow state; must have a `documentJob`.
 * @param page - 1-based page to show.
 * @param text - The page's translation (the correction when one exists).
 * @returns The fields to patch, or an empty patch without a job.
 */
export function showDocumentPage(
  state: PaneState,
  page: number,
  text: string,
): Partial<TranslationWorkflowState> {
  const job = state.documentJob;
  if (!job) return {};
  const readerHoldsPane = job.viewPage !== undefined;
  return {
    finalText: text,
    assessment: undefined,
    documentJob: { ...job, page, viewPage: page },
    ...(!readerHoldsPane && {
      textModeResult: {
        finalText: state.finalText,
        assessment: state.assessment,
      },
    }),
  };
}

/**
 * Hands the translation pane back to the text modes, restoring what they
 * had produced.
 *
 * @param state - Current workflow state.
 * @returns The fields to patch; an empty patch when the reader does not
 *   hold the pane.
 */
export function leaveDocumentReader(
  state: PaneState,
): Partial<TranslationWorkflowState> {
  const job = state.documentJob;
  if (!job || job.viewPage === undefined) return {};
  return {
    finalText: state.textModeResult?.finalText,
    assessment: state.textModeResult?.assessment,
    textModeResult: undefined,
    documentJob: { ...job, viewPage: undefined },
  };
}
