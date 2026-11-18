'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  NativePdfGlossaries,
  renderNativePdf,
  reviseNativePdfUnit,
  runNativePdf,
} from '@/client/services/workflows/nativePdfTranslation';

import {
  FormattedDocumentOptions,
  FormattedDocumentRun,
  applyRenderReport,
  combineRuns,
  formatPageSelection,
  removedPages,
  runFromReport,
  stalePages,
  translationsForRender,
  withUnitEdit,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NATIVE_PDF_MAX_CHECK_PAGES,
  NATIVE_PDF_STEPS,
  NativePdfDepth,
  NativePdfStepId,
  NativePdfStepInstructions,
  NativePdfUnitAction,
  NativePdfUnitResult,
  splitIntoRequests,
} from '@/lib/utils/shared/translation/nativePdf';

/** One step of a run in progress. */
export interface FormattedStepProgress {
  id: NativePdfStepId;
  status: 'upcoming' | 'active' | 'done' | 'skipped';
  /** What the step did, once it has ended. */
  detail?: string;
  durationMs?: number;
}

/** A run in progress. */
export interface FormattedRunProgress {
  /** Epoch milliseconds the run started at. */
  startedAt: number;
  /** Pages in the whole batch. */
  pageCount: number;
  /** Steps of the request in progress. */
  steps: FormattedStepProgress[];
  /** 1-based request in progress, and how many the batch takes. */
  part: number;
  parts: number;
  /** The finished requests are being put into one document. */
  assembling: boolean;
}

export interface StartFormattedRun {
  /** Returns the PDF to translate. */
  loadFile: () => Promise<File>;
  sourceUrl: string;
  sourceName: string;
  /** Display label of the target language. */
  targetLanguage: string;
  options: FormattedDocumentOptions;
  depth: NativePdfDepth;
  /** The batch's pages (see planBatch), ascending. */
  pages: number[];
  /** Pages one request takes, as the server said; absent uses its default. */
  requestPages?: number;
  /** Earlier batches of this document to add the new pages to. */
  base?: FormattedDocumentRun;
}

interface UseFormattedDocumentInput {
  conversationId: string;
  /** The stored run, if one has finished. */
  run: FormattedDocumentRun | undefined;
  /** Stores a run (a first batch, or all batches joined), replacing the previous one. */
  setRun: (run: FormattedDocumentRun) => void;
  /** Applies a change to the stored run. */
  updateRun: (
    update: (run: FormattedDocumentRun) => FormattedDocumentRun,
  ) => void;
  glossaries: NativePdfGlossaries;
  modelId?: string;
  /** Called after any request that spent tokens, to refresh limits. */
  onSpent?: () => void;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const upcomingSteps = (): FormattedStepProgress[] =>
  NATIVE_PDF_STEPS.map((step) => ({ id: step.id, status: 'upcoming' }));

/** Times the joining of finished pages into one document is attempted. */
const ASSEMBLE_ATTEMPTS = 2;

/**
 * Runs and edits a formatting-preserving document translation.
 *
 * The finished run lives in workflow state (through `setRun` /
 * `updateRun`); this hook holds only what is transient: the run in
 * progress, the request being waited on, and the last error of each kind.
 * Requests are stopped when the workspace unmounts.
 */
export function useFormattedDocument(input: UseFormattedDocumentInput) {
  const { conversationId, run, setRun, updateRun, modelId, onSpent } = input;
  const [progress, setProgress] = useState<FormattedRunProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [busyUnitId, setBusyUnitId] = useState<string | null>(null);
  const [unitError, setUnitError] = useState<string | null>(null);
  const runAbort = useRef<AbortController | null>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const glossaries = useRef(input.glossaries);
  useEffect(() => {
    glossaries.current = input.glossaries;
  });
  useEffect(
    () => () => {
      runAbort.current?.abort();
      requestAbort.current?.abort();
    },
    [],
  );

  /**
   * Translates one batch. A batch larger than one request takes is sent as
   * several, one after the other; whatever finished is then joined with
   * the earlier batches into one document, also when a later request fails
   * or the person stops, so finished pages are never thrown away.
   *
   * A batch already in progress is left alone.
   */
  const start = useCallback(
    async (request: StartFormattedRun) => {
      if (runAbort.current) return;
      let abort = new AbortController();
      runAbort.current = abort;
      setRunError(null);
      const requests = splitIntoRequests(
        request.pages,
        request.requestPages || undefined,
      );
      const progressAt = (part: number, assembling = false) => ({
        pageCount: request.pages.length,
        steps: upcomingSteps(),
        part,
        parts: requests.length,
        assembling,
      });
      const startedAt = Date.now();
      setProgress({ startedAt, ...progressAt(1) });
      const pieces: FormattedDocumentRun[] = [];
      let failure: unknown = null;
      try {
        const file = await request.loadFile();
        for (const [index, pages] of requests.entries()) {
          if (index > 0) setProgress({ startedAt, ...progressAt(index + 1) });
          const { report, totalTokens } = await runNativePdf({
            file,
            targetLanguage: request.targetLanguage,
            pages: formatPageSelection(pages),
            instructions: request.options.instructions,
            refitRounds: request.options.refitRounds,
            depth: request.depth,
            ...glossaries.current,
            modelId,
            conversationId,
            signal: abort.signal,
            onStep: (step) =>
              setProgress(
                (current) =>
                  current && {
                    ...current,
                    steps: current.steps.map((existing) =>
                      existing.id === step.id ? { ...step } : existing,
                    ),
                  },
              ),
          });
          pieces.push(
            runFromReport(report, {
              sourceUrl: request.sourceUrl,
              sourceName: request.sourceName,
              targetLanguage: request.targetLanguage,
              depth: request.depth,
              totalTokens,
            }),
          );
        }
      } catch (error) {
        failure = error;
      }
      try {
        if (pieces.length > 0) {
          const combined = combineRuns(request.base, pieces);
          if (!request.base && pieces.length === 1) {
            setRun(combined);
          } else {
            // Joining is its own request, so stopping the batch does not
            // stop it; a second Stop does.
            abort = new AbortController();
            runAbort.current = abort;
            setProgress({ startedAt, ...progressAt(requests.length, true) });
            const assemble = () =>
              renderNativePdf({
                sourceId: combined.sourceId,
                unitsIds: [
                  ...(request.base ? [request.base.unitsId] : []),
                  ...pieces.map((piece) => piece.unitsId),
                ],
                translations: translationsForRender(combined),
                checkPages: [],
                // Every page's image is already here, except pages whose
                // edits this render puts on the page for the first time.
                imagePages: stalePages(combined),
                omitPages: removedPages(combined),
                instructions: {},
                modelId,
                conversationId,
                signal: abort.signal,
              });
            let report: Awaited<ReturnType<typeof assemble>> | null = null;
            for (let attempt = 1; !report; attempt += 1) {
              try {
                report = await assemble();
              } catch (error) {
                if (isAbort(error) || attempt >= ASSEMBLE_ATTEMPTS) throw error;
              }
            }
            setRun(applyRenderReport(combined, report));
          }
        }
      } catch (error) {
        failure = failure && !isAbort(failure) ? failure : error;
      } finally {
        if (failure && !isAbort(failure)) setRunError(message(failure));
        runAbort.current = null;
        setProgress(null);
        onSpent?.();
      }
    },
    [conversationId, modelId, onSpent, setRun],
  );

  /**
   * Stops the batch in progress. Pages of requests that already finished
   * are kept and joined; the request in progress is discarded.
   */
  const stop = useCallback(() => runAbort.current?.abort(), []);

  /**
   * Lays the pages out again with the person's edits, leaving out the
   * pages they removed from the download.
   *
   * @param check - Also run the layout check on the edited pages.
   * @param instructions - Step instructions; only the check's applies.
   */
  const rerender = useCallback(
    async (check: boolean, instructions: NativePdfStepInstructions) => {
      if (!run || rendering) return;
      const abort = new AbortController();
      requestAbort.current = abort;
      setRendering(true);
      setRenderError(null);
      try {
        const report = await renderNativePdf({
          sourceId: run.sourceId,
          unitsIds: [run.unitsId],
          translations: translationsForRender(run),
          checkPages: check
            ? stalePages(run).slice(0, NATIVE_PDF_MAX_CHECK_PAGES)
            : [],
          imagePages: stalePages(run),
          omitPages: removedPages(run),
          instructions,
          modelId,
          conversationId,
          signal: abort.signal,
        });
        // Folded into the run as it was SENT: edits typed while waiting
        // are kept on top by re-applying them.
        updateRun((latest) => {
          let next = applyRenderReport(run, report);
          for (const [id, text] of Object.entries(latest.edits)) {
            if (run.edits[id] !== text) next = withUnitEdit(next, id, text);
          }
          return {
            ...next,
            page: latest.page,
            dismissed: latest.dismissed,
            // A page removed or put back while waiting is still pending.
            removedPages: latest.removedPages,
          };
        });
      } catch (error) {
        if (!isAbort(error)) setRenderError(message(error));
      } finally {
        setRendering(false);
        onSpent?.();
      }
    },
    [conversationId, modelId, onSpent, rendering, run, updateRun],
  );

  /**
   * Asks for a new wording of one block and records it as an edit.
   *
   * @param unit - The block.
   * @param action - What to do with it.
   * @param current - The block's translation as the person now has it.
   * @param instruction - What to change, for the `change` action.
   */
  const reviseUnit = useCallback(
    async (
      unit: NativePdfUnitResult,
      action: NativePdfUnitAction,
      current: string | null,
      instruction?: string,
    ) => {
      if (!run || busyUnitId) return;
      const abort = new AbortController();
      requestAbort.current = abort;
      setBusyUnitId(unit.id);
      setUnitError(null);
      try {
        const revised = await reviseNativePdfUnit({
          action,
          targetLanguage: run.targetLanguage,
          source: unit.source,
          translation: current ?? '',
          instruction,
          targetChars: unit.budgetChars,
          ...glossaries.current,
          modelId,
          conversationId,
          signal: abort.signal,
        });
        updateRun((latest) => withUnitEdit(latest, unit.id, revised.text));
      } catch (error) {
        if (!isAbort(error)) setUnitError(message(error));
      } finally {
        setBusyUnitId(null);
        onSpent?.();
      }
    },
    [busyUnitId, conversationId, modelId, onSpent, run, updateRun],
  );

  return {
    progress,
    running: progress !== null,
    runError,
    clearRunError: useCallback(() => setRunError(null), []),
    start,
    stop,
    rendering,
    renderError,
    rerender,
    busyUnitId,
    unitError,
    reviseUnit,
  };
}

export type FormattedDocumentController = ReturnType<
  typeof useFormattedDocument
>;
