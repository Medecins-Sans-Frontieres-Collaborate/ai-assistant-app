/**
 * Presentations translated in the background (Preserve formatting): the
 * `deck-translation` kind of background job (THE JOB CONVENTION in
 * lib/services/backgroundJobs/backgroundJobs.ts).
 *
 * A PDF run is driven by the browser, one streamed request per batch. A
 * deck run takes longer (every rebuild waits for a LibreOffice slot), so
 * the server drives it: starting it returns at once and the browser reads
 * its progress.
 *
 * What the kind adds to the convention:
 *  - STATE lives in the run's own folder (RUN_JOB_ID), encrypted with the
 *    run when the run is.
 *  - BATCHES are done in order and each one's results are stored before the
 *    next starts. A job picked up again continues with the first batch not
 *    finished: finished batches are never translated, or charged, again.
 *  - ONE ACTIVE RUN PER PERSON: the person's slot names the running job.
 *  - A damaged deck is repaired once (LibreOffice) and the batch tried
 *    again.
 */
import { Session } from 'next-auth';

import {
  ABANDONED_MS,
  HEARTBEAT_MS,
  JobActiveError,
  JobKind,
  JobRun,
  JobSlotRecord,
  JobSlots,
  JobStateBase,
  STALLED_MS,
  assertSlotFree as assertJobSlotFree,
  claimSlot as claimJobSlot,
  isActive,
  isRunningHere as isJobRunningHere,
  isStalled as isJobStalled,
  jobInProcess as jobPromise,
  readJob,
  resumeJob,
  startJob,
  stopJob,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import { repairDeck } from '@/lib/services/documentTranslation/deck/deckJob';
import { DocumentRefusedError } from '@/lib/services/documents/model/inspect';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import {
  NativeDeckJobPiece,
  NativeDeckJobStatus,
  NativeDeckJobStep,
} from '@/lib/utils/shared/translation/nativeDeckJob';
import { NativeDeckFormat } from '@/lib/utils/shared/translation/nativeFormats';
import {
  NATIVE_PDF_STEPS,
  NativePdfBrief,
  NativePdfDepth,
  NativePdfRenderReport,
  NativePdfStepInstructions,
  NativePdfStepRecord,
} from '@/lib/utils/shared/translation/nativePdf';
import { NativeRunBackend } from '@/lib/utils/shared/translation/nativeRunStorage';

import { GlossaryEntry } from '@/types/workflow';

import {
  rerenderNativePdf,
  runNativePdfTranslation,
} from './nativePdfPipeline';
import { NativeRunStore } from './nativePdfStorage';

export { ABANDONED_MS, HEARTBEAT_MS, STALLED_MS, isActive };

export const DECK_JOB_VERSION = 1;

/** Shared with the browser (nativeDeckJob.ts), so the two cannot drift. */
export type DeckJobStatus = NativeDeckJobStatus;
export type DeckJobStep = NativeDeckJobStep;
export type DeckJobPiece = NativeDeckJobPiece;

/** What the job was asked to do; fixed when it starts. */
export interface DeckJobRequest {
  sourceName: string;
  /** The stored deck (`<sha256>.<format>`). */
  sourceId: string;
  format: NativeDeckFormat;
  /** Set when the upload was a `.ppt`, converted before the run. */
  convertedFrom?: 'ppt';
  /**
   * Set when the deck was damaged and LibreOffice repaired it: `sourceId`
   * and `format` are then the repaired `.pptx`'s.
   */
  repaired?: boolean;
  targetLanguage: string;
  depth: NativePdfDepth;
  instructions: NativePdfStepInstructions;
  refitRounds: number;
  translateNotes: boolean;
  modelId: string;
  glossaryEntries: GlossaryEntry[];
  /** The brief of earlier batches of this document, if any. */
  brief?: NativePdfBrief;
  conversationId?: string;
  /** The requests, in order: each a list of slides. */
  batches: number[][];
}

/** The state of a job (THE JOB CONVENTION in backgroundJobs.ts). */
export interface DeckJobState extends JobStateBase {
  version: typeof DECK_JOB_VERSION;
  runId: string;
  backend: NativeRunBackend;
  request: DeckJobRequest;
  /** Finished batches, in order. */
  pieces: DeckJobPiece[];
  /** The brief after the last finished batch. */
  brief?: NativePdfBrief;
  /** The batch in progress. */
  current?: {
    /** 1-based index into `request.batches`. */
    part: number;
    steps: DeckJobStep[];
    /** Jobs ahead in the render queue while waiting for a slot. */
    queueAhead?: number;
  };
  /** The batches put together into one document, when there were several. */
  assembled?: NativePdfRenderReport;
}

/** The person's one active deck run (THE JOB CONVENTION). */
export interface DeckRunSlotRecord {
  runId: string;
  backend: NativeRunBackend;
  sourceName: string;
  heartbeatAt: number;
}

/** Where a person's slot is kept. */
export interface DeckRunSlot {
  read(): Promise<DeckRunSlotRecord | null>;
  write(record: DeckRunSlotRecord): Promise<void>;
  /** Frees the slot if it still names `runId`. */
  release(runId: string): Promise<void>;
}

/** A second run while one is active. */
export class DeckRunActiveError extends Error {
  readonly code = 'DECK_RUN_ACTIVE';
  constructor(readonly active: DeckRunSlotRecord) {
    super(
      `"${active.sourceName}" is still being translated. Wait for it to finish, or stop it, before starting another presentation.`,
    );
    this.name = 'DeckRunActiveError';
  }
}

/** What a job needs from the world; replaced in tests. */
export interface DeckJobDeps {
  translate: typeof runNativePdfTranslation;
  rerender: typeof rerenderNativePdf;
  now: () => number;
  heartbeatMs: number;
  /** Most slides one document may carry translations on. */
  maxDocumentPages: number;
  /** Has LibreOffice repair a damaged deck (deckJob.ts repairDeck). */
  repair: typeof repairDeck;
}

const DEFAULT_DEPS: DeckJobDeps = {
  translate: runNativePdfTranslation,
  rerender: rerenderNativePdf,
  repair: repairDeck,
  now: Date.now,
  heartbeatMs: HEARTBEAT_MS,
  maxDocumentPages: Number.MAX_SAFE_INTEGER,
};

/** What the deck kind's work runs with. */
interface DeckJobContext {
  store: NativeRunStore;
  user: Session['user'];
  deps: DeckJobDeps;
}

const upcomingSteps = (): DeckJobStep[] =>
  NATIVE_PDF_STEPS.map((step) => ({ id: step.id, status: 'upcoming' }));

/**
 * Translates every batch not yet finished, then joins them into one
 * document when there are several.
 */
async function translateDeck(
  job: JobRun<DeckJobState>,
  { store, user, deps }: DeckJobContext,
): Promise<void> {
  // Replaced once if the deck has to be repaired.
  let request = job.state().request;
  let document = await store.get(request.sourceId);
  const usage = new WorkflowUsageCollector({
    user,
    action: 'native-deck-translate',
    conversationId: request.conversationId,
  });
  for (
    let index = job.state().pieces.length;
    index < request.batches.length;
    index += 1
  ) {
    job.signal.throwIfAborted();
    job.update((state) => ({
      ...state,
      current: { part: index + 1, steps: upcomingSteps() },
    }));
    await job.save();
    const translateBatch = () =>
      job.untilStopped(
        deps.translate({
          document,
          format: request.format,
          translateNotes: request.translateNotes,
          targetLanguage: request.targetLanguage,
          pages: request.batches[index],
          instructions: request.instructions,
          modelId: request.modelId,
          maxRefitRounds: request.refitRounds,
          depth: request.depth,
          glossaryEntries: request.glossaryEntries,
          brief: job.state().brief ?? request.brief,
          signal: job.signal,
          usage,
          onQueue: (ahead) => {
            const current = job.state().current;
            if (current && current.queueAhead !== ahead) {
              job.update((state) => ({
                ...state,
                current: state.current && {
                  ...state.current,
                  queueAhead: ahead,
                },
              }));
              void job.save();
            }
          },
          onStep: (event) => {
            if (!job.state().current) return;
            const record = event as NativePdfStepRecord;
            job.update((state) => ({
              ...state,
              current: state.current && {
                ...state.current,
                queueAhead: undefined,
                steps: state.current.steps.map((step) =>
                  step.id === event.id
                    ? {
                        id: step.id,
                        status: event.status,
                        ...(record.detail !== undefined
                          ? { detail: record.detail }
                          : {}),
                        ...(record.durationMs !== undefined
                          ? { durationMs: record.durationMs }
                          : {}),
                      }
                    : step,
                ),
              },
            }));
            void job.save();
          },
        }),
      );
    let result: Awaited<ReturnType<typeof translateBatch>>;
    try {
      result = await translateBatch();
    } catch (error) {
      // A damaged deck is repaired once (LibreOffice), then the batch is
      // tried again; the sandbox refuses it before anything is charged.
      const damaged =
        error instanceof DocumentRefusedError && error.code === 'DAMAGED';
      if (!damaged || request.repaired) throw error;
      document = await deps.repair(document, request.format, job.signal);
      const repairedSource = await store.put(document, 'pptx');
      request = {
        ...request,
        sourceId: repairedSource.id,
        format: 'pptx',
        repaired: true,
      };
      job.update((state) => ({ ...state, request }));
      await job.save();
      result = await translateBatch();
    }
    const { pdf, outputs, unitsFile, document: translated, ...report } = result;
    const [stored, units] = await Promise.all([
      store.putRebuild({
        pdf,
        outputs,
        ...(translated
          ? { document: { data: translated, format: request.format } }
          : {}),
      }),
      store.put(unitsFile, 'json'),
    ]);
    const piece: DeckJobPiece = {
      ...report,
      ...stored,
      format: request.format,
      sourceId: request.sourceId,
      unitsId: units.id,
      ...usage.fields(),
    };
    job.update((state) => ({
      ...state,
      pieces: [...state.pieces, piece],
      brief: report.brief,
      current: undefined,
    }));
    await job.save();
  }

  // Several batches become one document; one batch already is.
  if (job.state().pieces.length > 1 && !job.state().assembled) {
    job.signal.throwIfAborted();
    const unitsFiles = await Promise.all(
      job.state().pieces.map((piece) => store.get(piece.unitsId)),
    );
    const translations: Record<string, string> = {};
    for (const piece of job.state().pieces) {
      for (const unit of piece.units) {
        if (unit.translation !== null) translations[unit.id] = unit.translation;
      }
    }
    const styles = Object.assign(
      {},
      ...job.state().pieces.map((piece) => piece.styles ?? {}),
    );
    const {
      pdf,
      outputs,
      exports: _exports,
      unitsFile,
      document: translated,
      ...rendered
    } = await job.untilStopped(
      deps.rerender({
        document,
        format: request.format,
        unitsFiles,
        translations,
        styles,
        language: job.state().brief?.language?.code,
        // Every slide's picture is already stored with its batch.
        imagePages: [],
        checkPages: [],
        maxDocumentPages: deps.maxDocumentPages,
        instructions: {},
        modelId: request.modelId,
        usage,
        signal: job.signal,
        onQueue: (ahead) => {
          job.update((state) => ({
            ...state,
            current: {
              part: request.batches.length,
              steps: [],
              queueAhead: ahead,
            },
          }));
          void job.save();
        },
      }),
    );
    const [stored, units] = await Promise.all([
      store.putRebuild({
        pdf,
        outputs,
        ...(translated
          ? { document: { data: translated, format: request.format } }
          : {}),
      }),
      store.put(unitsFile, 'json'),
    ]);
    job.update((state) => ({
      ...state,
      current: undefined,
      assembled: { ...rendered, ...stored, unitsId: units.id },
    }));
  }
}

/** The deck translation kind of background job. */
export const DECK_JOB_KIND: JobKind<
  DeckJobRequest,
  DeckJobState,
  DeckJobContext
> = {
  kind: 'deck-translation',
  version: DECK_JOB_VERSION,
  limitPerPerson: 1,
  label: (request) => request.sourceName,
  initial: (_request, { store }) => ({
    runId: store.location.runId,
    backend: store.location.backend,
    pieces: [],
    current: { part: 1, steps: upcomingSteps() },
  }),
  settle: (state) => ({ ...state, current: undefined }),
  failureMessage: 'The presentation could not be translated',
  run: translateDeck,
};

/** The person's deck slot as the runner's slots. */
function deckSlots(slot: DeckRunSlot, backend: NativeRunBackend): JobSlots {
  return {
    read: async () => {
      const held = await slot.read();
      return held ? [jobSlotRecord(held)] : [];
    },
    write: (record) => slot.write(deckSlotRecord(record, backend)),
    release: (key) => slot.release(key),
  };
}

const jobSlotRecord = (record: DeckRunSlotRecord): JobSlotRecord => ({
  key: record.runId,
  label: record.sourceName,
  heartbeatAt: record.heartbeatAt,
  data: { backend: record.backend },
});

const deckSlotRecord = (
  record: JobSlotRecord,
  backend: NativeRunBackend,
): DeckRunSlotRecord => ({
  runId: record.key,
  backend: (record.data?.backend as NativeRunBackend | undefined) ?? backend,
  sourceName: record.label,
  heartbeatAt: record.heartbeatAt,
});

/** The runner's refusal as the deck's. */
async function asDeck<T>(
  work: Promise<T>,
  backend: NativeRunBackend,
): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof JobActiveError) {
      throw new DeckRunActiveError(deckSlotRecord(error.active, backend));
    }
    throw error;
  }
}

/** Whether this process is running a run's job. */
export function isRunningHere(runId: string): boolean {
  return isJobRunningHere(DECK_JOB_KIND.kind, runId);
}

/** The job's promise in this process, for tests and shutdown. */
export function jobInProcess(runId: string): Promise<DeckJobState> | undefined {
  return jobPromise<DeckJobState>(DECK_JOB_KIND.kind, runId);
}

/**
 * Whether a running job has no one running it (THE JOB CONVENTION).
 *
 * @param state - The stored state.
 * @param now - The time now.
 */
export function isStalled(
  state: Pick<DeckJobState, 'status' | 'heartbeatAt' | 'runId'>,
  now: number,
): boolean {
  return isJobStalled(DECK_JOB_KIND.kind, state.runId, state, now);
}

/** Reads a job's state, or null when the run has none or it is unreadable. */
export function readDeckJob(
  store: NativeRunStore,
): Promise<DeckJobState | null> {
  return readJob<DeckJobState>(DECK_JOB_KIND, store);
}

/**
 * Checks the person's slot without taking it, so nothing is stored for a
 * run that would be refused.
 *
 * @throws DeckRunActiveError while another run holds it.
 */
export function assertSlotFree(
  slot: DeckRunSlot,
  runId: string,
  now: number,
): Promise<void> {
  return asDeck(
    assertJobSlotFree(DECK_JOB_KIND, deckSlots(slot, 'app'), runId, now),
    'app',
  );
}

/**
 * Claims the person's slot for a new run.
 *
 * @throws DeckRunActiveError while another run holds it.
 */
export function claimSlot(
  slot: DeckRunSlot,
  record: DeckRunSlotRecord,
  now: number,
): Promise<void> {
  return asDeck(
    claimJobSlot(
      DECK_JOB_KIND,
      deckSlots(slot, record.backend),
      jobSlotRecord(record),
      now,
    ),
    record.backend,
  );
}

/** Where a deck job lives and what it runs with. */
function placeOf(input: {
  store: NativeRunStore;
  slot: DeckRunSlot;
  user: Session['user'];
  deps?: Partial<DeckJobDeps>;
}) {
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const { runId, backend } = input.store.location;
  return {
    store: input.store,
    slots: deckSlots(input.slot, backend),
    key: runId,
    context: { store: input.store, user: input.user, deps },
    clock: { now: deps.now, heartbeatMs: deps.heartbeatMs },
  };
}

/**
 * Starts a deck run in the background.
 *
 * @param input - Where the run is, what to translate, and the person.
 * @returns The job's first state; the job goes on after this returns.
 * @throws DeckRunActiveError while the person has another run going.
 */
export function startDeckJob(input: {
  store: NativeRunStore;
  slot: DeckRunSlot;
  user: Session['user'];
  request: DeckJobRequest;
  deps?: Partial<DeckJobDeps>;
}): Promise<DeckJobState> {
  return asDeck(
    startJob(DECK_JOB_KIND, placeOf(input), input.request),
    input.store.location.backend,
  );
}

/**
 * Picks up a stalled job again (THE JOB CONVENTION): it continues with the
 * first batch not finished.
 *
 * @param state - The stored state; a job that is not stalled is returned
 *   as it is.
 * @returns The state as resumed.
 * @throws DeckRunActiveError when the person started another run meanwhile.
 */
export function resumeDeckJob(input: {
  store: NativeRunStore;
  slot: DeckRunSlot;
  user: Session['user'];
  state: DeckJobState;
  deps?: Partial<DeckJobDeps>;
}): Promise<DeckJobState> {
  return asDeck(
    resumeJob(DECK_JOB_KIND, placeOf(input), input.state),
    input.store.location.backend,
  );
}

/**
 * Asks a running job to stop (THE JOB CONVENTION). The instance running it
 * stops at its next heartbeat; one running here stops at once.
 *
 * @returns The state with the stop recorded.
 */
export function stopDeckJob(
  store: NativeRunStore,
  state: DeckJobState,
): Promise<DeckJobState> {
  return stopJob(DECK_JOB_KIND, state.runId, store, state);
}
