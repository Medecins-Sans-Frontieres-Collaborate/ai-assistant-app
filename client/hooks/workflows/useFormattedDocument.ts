'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DeckRunBusyError,
  readDeckJob,
  recordDeckJobUsage,
  startDeckJob,
  stopDeckJob,
} from '@/client/services/workflows/nativeDeckJob';
import { DeckJobReading } from '@/client/services/workflows/nativeDeckJob';
import {
  NativePdfGlossaries,
  renderNativePdf,
  reviseNativePdfUnit,
  runNativePdf,
} from '@/client/services/workflows/nativePdfTranslation';
import {
  RunAccess,
  isOneDriveUnavailable,
  newRunAccess,
} from '@/client/services/workflows/nativeRunStorage';

import {
  FormattedDocumentOptions,
  FormattedDocumentRun,
  FormattedPendingJob,
  applyRenderReport,
  combineRuns,
  formatPageSelection,
  removedPages,
  runFromReport,
  stalePages,
  translationsForRender,
  withUnitEdit,
} from '@/lib/utils/shared/translation/formattedDocument';
import { queueWaitEstimateMs } from '@/lib/utils/shared/translation/nativeDeckJob';
import { isNativeDeckUpload } from '@/lib/utils/shared/translation/nativeFormats';
import {
  NATIVE_PDF_MAX_CHECK_PAGES,
  NATIVE_PDF_STEPS,
  NativePdfDepth,
  NativePdfExportFormat,
  NativePdfRenderReport,
  NativePdfStepId,
  NativePdfStepInstructions,
  NativePdfUnitAction,
  NativePdfUnitResult,
  splitIntoRequests,
} from '@/lib/utils/shared/translation/nativePdf';
import { NativeRunBackend } from '@/lib/utils/shared/translation/nativeRunStorage';

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
  /**
   * A presentation waiting for the slide renderer: jobs ahead of it, and
   * about how long that may take (milliseconds; null when unknown).
   */
  queue?: { ahead: number; waitMs: number | null };
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
  /** A presentation: whether its speaker notes are translated too. */
  translateNotes?: boolean;
  /** The batch's pages (see planBatch), ascending. */
  pages: number[];
  /** Pages one request takes, as the server said; absent uses its default. */
  requestPages?: number;
  /** Earlier batches of this document to add the new pages to. */
  base?: FormattedDocumentRun;
  /**
   * Where a new run's files go. Pages added to `base` go where it is.
   * A new run that cannot use OneDrive is kept in app storage instead.
   */
  backend: NativeRunBackend;
}

interface UseFormattedDocumentInput {
  conversationId: string;
  /** The stored run, if one has finished. */
  run: FormattedDocumentRun | undefined;
  /** Where the stored run's files are. */
  access: RunAccess | undefined;
  /** Stores a run (a first batch, or all batches joined), replacing the previous one. */
  setRun: (run: FormattedDocumentRun, access: RunAccess) => void;
  /** Applies a change to the stored run. */
  updateRun: (
    update: (run: FormattedDocumentRun) => FormattedDocumentRun,
  ) => void;
  /** A presentation being translated in the background, if any. */
  pendingJob?: FormattedPendingJob;
  /** Remembers (or, with undefined, forgets) the pending job. */
  setPendingJob: (job: FormattedPendingJob | undefined) => void;
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

/** How often a presentation's background job is read while it runs. */
export const DECK_POLL_MS = 2_000;

/** Waits, unless stopped first. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** How long a job's end waits for the stored run to load. */
const RUN_LOAD_WAIT_MS = 30_000;

/**
 * Waits for a value to be there, checking a few times a second.
 *
 * @returns The value, or undefined after RUN_LOAD_WAIT_MS.
 */
async function loaded<T>(
  read: () => T | undefined,
  signal: AbortSignal,
): Promise<T | undefined> {
  const until = Date.now() + RUN_LOAD_WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() >= until) return value;
    await pause(250, signal);
  }
}

/**
 * A presentation job's progress as the run screen shows it.
 *
 * @param reading - The job and its queue, as last read.
 * @param startedAt - When the person started it.
 */
export function progressOfDeckJob(
  { job, queue }: DeckJobReading,
  startedAt: number,
): FormattedRunProgress {
  const ahead = job.current?.queueAhead ?? 0;
  return {
    startedAt,
    pageCount: job.pageCount,
    steps: job.current?.steps ?? upcomingSteps(),
    part: job.current?.part ?? Math.min(job.pieces.length + 1, job.parts),
    parts: job.parts,
    // Every batch done and the job still running: they are being joined.
    assembling:
      job.status === 'running' &&
      !job.current &&
      job.parts > 1 &&
      job.pieces.length === job.parts,
    ...(ahead > 0
      ? {
          queue: {
            ahead,
            waitMs: queue ? queueWaitEstimateMs(ahead, queue) : null,
          },
        }
      : {}),
  };
}

/**
 * Runs and edits a formatting-preserving document translation.
 *
 * The finished run lives in storage (through `setRun` / `updateRun`, see
 * useFormattedRunStorage); this hook holds only what is transient: the run in
 * progress, the request being waited on, and the last error of each kind.
 * Requests are stopped when the workspace unmounts.
 */
export function useFormattedDocument(input: UseFormattedDocumentInput) {
  const {
    conversationId,
    run,
    access,
    setRun,
    updateRun,
    modelId,
    onSpent,
    pendingJob,
    setPendingJob,
  } = input;
  const [progress, setProgress] = useState<FormattedRunProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  /** Another presentation of the person's holds their one deck slot. */
  const [busyWith, setBusyWith] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [busyUnitId, setBusyUnitId] = useState<string | null>(null);
  const [unitError, setUnitError] = useState<string | null>(null);
  const runAbort = useRef<AbortController | null>(null);
  /** The presentation job being followed; Stop asks the server to end it. */
  const followedJob = useRef<RunAccess | null>(null);
  /** The stored run as it is now, for work that outlives a render. */
  const runNow = useRef(run);
  useEffect(() => {
    runNow.current = run;
  });
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
   * Puts finished batches into the stored run: joined with `base` (earlier
   * batches of the document) into one document when there is more than one
   * piece, unless the server already joined them (`assembled`).
   *
   * @returns The failure to report, if joining failed.
   */
  const keepPieces = useCallback(
    async (
      pieces: FormattedDocumentRun[],
      base: FormattedDocumentRun | undefined,
      target: RunAccess,
      showAssembling: () => void,
      assembled?: NativePdfRenderReport,
    ): Promise<void> => {
      if (pieces.length === 0) return;
      const combined = combineRuns(base, pieces);
      if (!base && (pieces.length === 1 || assembled)) {
        setRun(
          assembled ? applyRenderReport(combined, assembled) : combined,
          target,
        );
        return;
      }
      // Joining is its own request, so stopping the batch does not stop
      // it; a second Stop does.
      const abort = new AbortController();
      runAbort.current = abort;
      showAssembling();
      const assemble = () =>
        renderNativePdf({
          run: target,
          sourceId: combined.sourceId,
          unitsIds: [
            ...(base ? [base.unitsId] : []),
            ...pieces.map((piece) => piece.unitsId),
          ],
          translations: translationsForRender(combined),
          checkPages: [],
          // Every page's image is already here, except pages whose edits
          // this render puts on the page for the first time.
          imagePages: stalePages(combined),
          omitPages: removedPages(combined),
          styles: combined.styles ?? {},
          language: combined.brief?.language?.code,
          instructions: {},
          modelId,
          conversationId,
          signal: abort.signal,
        });
      let report: NativePdfRenderReport | null = null;
      for (let attempt = 1; !report; attempt += 1) {
        try {
          report = await assemble();
        } catch (error) {
          if (isAbort(error) || attempt >= ASSEMBLE_ATTEMPTS) throw error;
        }
      }
      setRun(applyRenderReport(combined, report), target);
    },
    [conversationId, modelId, setRun],
  );

  /**
   * Follows a presentation job until it ends, showing its progress, then
   * puts its finished batches into the run. Stopping the page (unmount)
   * leaves the job running on the server; it is followed again next time.
   */
  const followDeckJob = useCallback(
    async (job: FormattedPendingJob, abort: AbortController) => {
      runAbort.current = abort;
      followedJob.current = job.access;
      let failure: unknown = null;
      let reading: DeckJobReading | null = null;
      try {
        for (;;) {
          reading = await readDeckJob(job.access, abort.signal);
          setProgress(progressOfDeckJob(reading, job.startedAt));
          if (reading.job.status !== 'running') break;
          await pause(DECK_POLL_MS, abort.signal);
        }
      } catch (error) {
        failure = error;
      }
      followedJob.current = null;
      if (isAbort(failure) || !reading || reading.job.status === 'running') {
        // Left, or the job could not be read: it stays remembered.
        if (failure && !isAbort(failure)) setRunError(message(failure));
        runAbort.current = null;
        setProgress(null);
        return;
      }
      const ended = reading.job;
      recordDeckJobUsage(ended, conversationId);
      if (ended.status === 'failed') {
        failure = new Error(ended.error ?? 'The translation failed');
      }
      // Slides added to the stored run need it loaded (after a reload it
      // may still be on its way); without it they would replace it.
      let base: FormattedDocumentRun | undefined;
      if (job.addsToBase) {
        base = await loaded(() => runNow.current, abort.signal).catch(
          () => undefined,
        );
        if (!base) {
          setRunError(
            message(new Error('The earlier pages could not be loaded')),
          );
          runAbort.current = null;
          setProgress(null);
          return;
        }
      }
      const pieces = ended.pieces.map((piece) => ({
        ...runFromReport(piece, {
          sourceUrl: job.sourceUrl,
          sourceName: job.sourceName,
          targetLanguage: job.targetLanguage,
          depth: job.depth,
          totalTokens: piece.usage?.totalTokens ?? 0,
        }),
        translateNotes: ended.translateNotes,
      }));
      try {
        await keepPieces(
          pieces,
          base,
          job.access,
          () =>
            setProgress(
              (current) => current && { ...current, assembling: true },
            ),
          ended.assembled,
        );
      } catch (error) {
        failure = failure ?? error;
      } finally {
        setPendingJob(undefined);
        if (failure && !isAbort(failure)) setRunError(message(failure));
        runAbort.current = null;
        setProgress(null);
        onSpent?.();
      }
    },
    [conversationId, keepPieces, onSpent, setPendingJob],
  );

  // A job remembered from before a reload is followed again.
  const pendingRunId = pendingJob?.access.runId;
  const pendingNow = useRef(pendingJob);
  useEffect(() => {
    pendingNow.current = pendingJob;
  });
  useEffect(() => {
    const job = pendingNow.current;
    if (!pendingRunId || !job || runAbort.current) return;
    void followDeckJob(job, new AbortController());
    // Followed once per job; a new follower is not wanted on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRunId]);

  /**
   * Starts a presentation's job, then follows it. Another of the person's
   * presentations still running refuses it, naming that one.
   */
  const startDeck = useCallback(
    async (request: StartFormattedRun, abort: AbortController) => {
      const startedAt = Date.now();
      setProgress({
        startedAt,
        pageCount: request.pages.length,
        steps: upcomingSteps(),
        part: 1,
        parts: splitIntoRequests(
          request.pages,
          request.requestPages || undefined,
        ).length,
        assembling: false,
      });
      try {
        const file = await request.loadFile();
        const brief =
          request.base?.targetLanguage === request.targetLanguage
            ? request.base.brief
            : undefined;
        let target =
          request.base && access ? access : await newRunAccess(request.backend);
        const begin = (run: RunAccess) =>
          startDeckJob({
            run,
            file,
            targetLanguage: request.targetLanguage,
            pages: formatPageSelection(request.pages),
            translateNotes: request.translateNotes ?? true,
            brief,
            instructions: request.options.instructions,
            refitRounds: request.options.refitRounds,
            depth: request.depth,
            ...glossaries.current,
            modelId,
            conversationId,
            signal: abort.signal,
          });
        try {
          await begin(target);
        } catch (error) {
          // OneDrive refused before anything was stored: a new run goes to
          // app storage instead.
          if (request.base || target.backend !== 'onedrive') throw error;
          if (!isOneDriveUnavailable(error)) throw error;
          target = { ...target, backend: 'app' };
          await begin(target);
        }
        const job: FormattedPendingJob = {
          access: target,
          sourceUrl: request.sourceUrl,
          sourceName: request.sourceName,
          targetLanguage: request.targetLanguage,
          depth: request.depth,
          addsToBase: !!request.base,
          startedAt,
        };
        setPendingJob(job);
        await followDeckJob(job, abort);
      } catch (error) {
        if (error instanceof DeckRunBusyError) setBusyWith(error.activeName);
        else if (!isAbort(error)) setRunError(message(error));
        runAbort.current = null;
        setProgress(null);
      }
    },
    [access, conversationId, followDeckJob, modelId, setPendingJob],
  );

  /**
   * Translates one batch. A batch larger than one request takes is sent as
   * several, one after the other; whatever finished is then joined with
   * the earlier batches into one document, also when a later request fails
   * or the person stops, so finished pages are never thrown away.
   * A presentation goes to the server as one background job instead
   * (startDeck), which splits it the same way.
   *
   * A batch already in progress is left alone.
   */
  const start = useCallback(
    async (request: StartFormattedRun) => {
      if (runAbort.current) return;
      const abort = new AbortController();
      runAbort.current = abort;
      setRunError(null);
      setBusyWith(null);
      if (isNativeDeckUpload(request.sourceName)) {
        await startDeck(request, abort);
        return;
      }
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
      // What the document's earlier pages settled (language, names); each
      // request adds to it and the next one starts from the result.
      // A brief settled for another language says nothing about this one.
      let brief =
        request.base?.targetLanguage === request.targetLanguage
          ? request.base.brief
          : undefined;
      let failure: unknown = null;
      // Every request of the batch writes into one run: the earlier
      // batches' when adding to them, otherwise a new one.
      let target: RunAccess | null = null;
      try {
        const file = await request.loadFile();
        target =
          request.base && access ? access : await newRunAccess(request.backend);
        for (const [index, pages] of requests.entries()) {
          if (index > 0) setProgress({ startedAt, ...progressAt(index + 1) });
          const translate = (run: RunAccess) =>
            runNativePdf({
              run,
              file,
              targetLanguage: request.targetLanguage,
              brief,
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
          let answer: Awaited<ReturnType<typeof translate>>;
          try {
            answer = await translate(target);
          } catch (error) {
            // OneDrive refused before anything was written: a new run
            // goes to app storage instead (the server opens storage
            // before it translates, so nothing was spent).
            const movable =
              index === 0 && !request.base && target.backend === 'onedrive';
            if (!movable || !isOneDriveUnavailable(error)) throw error;
            target = { ...target, backend: 'app' };
            answer = await translate(target);
          }
          const { report, totalTokens } = answer;
          brief = report.brief ?? brief;
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
        if (target) {
          await keepPieces(pieces, request.base, target, () =>
            setProgress({ startedAt, ...progressAt(requests.length, true) }),
          );
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
    [access, conversationId, keepPieces, modelId, onSpent, startDeck],
  );

  /**
   * Stops the batch in progress. Pages of requests that already finished
   * are kept and joined; the request in progress is discarded. A
   * presentation's job is asked to stop on the server, and followed until
   * it has.
   */
  const stop = useCallback(() => {
    const job = followedJob.current;
    if (job) {
      void stopDeckJob(job).catch((error: unknown) =>
        setRunError(message(error)),
      );
      return;
    }
    runAbort.current?.abort();
  }, []);

  /**
   * Lays the pages out again with the person's edits, leaving out the
   * pages they removed from the download.
   *
   * @param check - Also run the layout check on the edited pages.
   * @param instructions - Step instructions; only the check's applies.
   * @param exports - Editable formats to build with the PDF (EDITABLE
   *   DOWNLOADS in nativePdf.ts).
   * @returns The server's answer, or null when the render did not happen
   *   or failed (the reason is then in `renderError`).
   */
  const rerender = useCallback(
    async (
      check: boolean,
      instructions: NativePdfStepInstructions,
      exports: NativePdfExportFormat[] = [],
    ): Promise<NativePdfRenderReport | null> => {
      if (!run || !access || rendering) return null;
      const abort = new AbortController();
      requestAbort.current = abort;
      setRendering(true);
      setRenderError(null);
      try {
        const report = await renderNativePdf({
          run: access,
          sourceId: run.sourceId,
          unitsIds: [run.unitsId],
          translations: translationsForRender(run),
          checkPages: check
            ? stalePages(run).slice(0, NATIVE_PDF_MAX_CHECK_PAGES)
            : [],
          imagePages: stalePages(run),
          omitPages: removedPages(run),
          styles: run.styles ?? {},
          language: run.brief?.language?.code,
          exports,
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
            // A page removed or put back while waiting is still pending,
            // and so is a look changed meanwhile.
            removedPages: latest.removedPages,
            styles: latest.styles,
          };
        });
        return report;
      } catch (error) {
        if (!isAbort(error)) setRenderError(message(error));
        return null;
      } finally {
        setRendering(false);
        onSpent?.();
      }
    },
    [access, conversationId, modelId, onSpent, rendering, run, updateRun],
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
          brief: run.brief,
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
    clearRunError: useCallback(() => {
      setRunError(null);
      setBusyWith(null);
    }, []),
    /** The name of the person's presentation that refused this one, if any. */
    busyWith,
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
