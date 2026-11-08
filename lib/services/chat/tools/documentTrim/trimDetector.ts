/**
 * FACTUAL eligibility checks for the document-trim pipeline, plus its
 * target types. Deliberately contains NO intent detection: this is a
 * heavily multilingual application, so "did the user ask to shorten the
 * document?" is classified by the router LLM (see
 * ToolRouterService.classifyDocumentTrim), which reads meaning in any
 * language. Only language-independent facts live here — which attachment
 * is trimmable, and how targets are represented.
 */

/**
 * Which way a classified length request moves the attached document.
 * 'reduce' runs the trim pipeline; 'expand' has no pipeline — the model
 * lengthens the document itself, and the enricher only checks whether the
 * document already meets the target.
 */
export type LengthChangeDirection = 'reduce' | 'expand';

/** A resolved length target for the trim pipeline (or an expansion check). */
export type TrimTarget = (
  | {
      kind: 'absolute';
      unit: 'words' | 'characters';
      target: number;
      /** Approximate targets (pages-derived, "about") widen acceptance. */
      approx: boolean;
    }
  | {
      kind: 'ratio';
      /**
       * Multiple of the current length to reach: below 1 to reduce
       * (0.5 = "cut in half"), above 1 to expand (2 = "double it").
       */
      keep: number;
      approx: true;
    }
) & {
  /** Absent = 'reduce', the only direction before expansion checks. */
  direction?: LengthChangeDirection;
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
