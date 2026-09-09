/**
 * FACTUAL eligibility checks for the document-trim pipeline, plus its
 * target types. Deliberately contains NO intent detection: this is a
 * heavily multilingual application, so "did the user ask to shorten the
 * document?" is classified by the router LLM (see
 * ToolRouterService.classifyDocumentTrim), which reads meaning in any
 * language. Only language-independent facts live here — which attachment
 * is trimmable, and how targets are represented.
 */

/** A resolved length target for the trim pipeline. */
export type TrimTarget =
  | {
      kind: 'absolute';
      unit: 'words' | 'characters';
      target: number;
      /** Approximate targets (pages-derived, "about") widen acceptance. */
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
export const WORDS_PER_PAGE = 500;

const FORMAT_BY_EXTENSION: Record<string, TrimmableFormat> = {
  docx: 'docx',
  md: 'md',
  markdown: 'md',
  txt: 'txt',
};

/**
 * Picks the document a trim would apply to from the attachment manifest.
 * Current-turn attachments win over prior-turn ones; within a turn, first
 * eligible file wins. Non-trimmable formats (PDF, XLSX, …) return null so
 * the turn falls through to normal routing instead of a doomed pipeline.
 * Purely factual — file extensions are language-independent.
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
