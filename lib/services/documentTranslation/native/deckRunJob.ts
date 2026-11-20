/**
 * Presentations translated in the background (Preserve formatting).
 *
 * A PDF run is driven by the browser, one streamed request per batch. A
 * deck run takes longer (every rebuild waits for a LibreOffice slot), so
 * the server drives it: starting it returns at once and the browser reads
 * its progress.
 *
 * THE JOB CONVENTION (stated once; the route and the tests cite it):
 *  - STATE lives in the run's own folder (RUN_JOB_ID), encrypted with the
 *    run when the run is, so it is as private as the run's files and every
 *    instance can read it.
 *  - A job is RUNNING while some instance writes a heartbeat into its state
 *    at least every HEARTBEAT_MS. A running job whose heartbeat is older
 *    than STALLED_MS has no one running it (a restart, a crash): the next
 *    read of its progress picks it up again (`resumeDeckJob`).
 *  - BATCHES are done in order and each one's results are stored before the
 *    next starts. A job picked up again continues with the first batch not
 *    finished: finished batches are never translated, or charged, again.
 *  - A STOP is a marker of its own (RUN_STOP_ID), so no progress write can
 *    overwrite it; the instance running the job sees it with its next
 *    heartbeat and stops. Finished batches are kept.
 *  - ONE ACTIVE RUN PER PERSON: a slot in the person's app storage names the
 *    running job. A second start is refused while the slot's job is running
 *    and was heard from within ABANDONED_MS.
 */
import { Session } from 'next-auth';

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
  NativePdfRunReport,
  NativePdfStepId,
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

import { randomUUID } from 'crypto';

/** How often a running job writes its heartbeat. */
export const HEARTBEAT_MS = 15_000;
/** A running job not heard from for this long has no one running it. */
export const STALLED_MS = 60_000;
/** A person's slot frees when its job has not been heard from for this long. */
export const ABANDONED_MS = 15 * 60_000;

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

/** The state of a job (see THE JOB CONVENTION). */
export interface DeckJobState {
  version: typeof DECK_JOB_VERSION;
  jobId: string;
  runId: string;
  backend: NativeRunBackend;
  request: DeckJobRequest;
  status: DeckJobStatus;
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
  startedAt: number;
  heartbeatAt: number;
  /** Times the job was picked up again after it stalled. */
  resumes: number;
  stopRequested?: boolean;
  error?: string;
}

/** The person's one active deck run (see THE JOB CONVENTION). */
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

// Jobs this process is running, by run id. On globalThis because the dev
// server reloads modules.
const JOBS_KEY = Symbol.for('ai-assistant.deck-jobs');
interface RunningJob {
  done: Promise<DeckJobState>;
  abort: AbortController;
}
type JobHolder = { [JOBS_KEY]?: Map<string, RunningJob> };

function runningHere(): Map<string, RunningJob> {
  const holder = globalThis as JobHolder;
  holder[JOBS_KEY] ??= new Map();
  return holder[JOBS_KEY];
}

/** Whether this process is running a run's job. */
export function isRunningHere(runId: string): boolean {
  return runningHere().has(runId);
}

/** The job's promise in this process, for tests and shutdown. */
export function jobInProcess(runId: string): Promise<DeckJobState> | undefined {
  return runningHere().get(runId)?.done;
}

/** Whether a job's state says someone should be running it. */
export function isActive(state: Pick<DeckJobState, 'status'>): boolean {
  return state.status === 'running';
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
  return (
    isActive(state) &&
    now - state.heartbeatAt > STALLED_MS &&
    !isRunningHere(state.runId)
  );
}

/** Reads a job's state, or null when the run has none or it is unreadable. */
export async function readDeckJob(
  store: NativeRunStore,
): Promise<DeckJobState | null> {
  const state = (await store.getJob()) as DeckJobState | null;
  if (!state || state.version !== DECK_JOB_VERSION) return null;
  return state;
}

/**
 * Checks the person's slot without taking it, so nothing is stored for a
 * run that would be refused.
 *
 * @throws DeckRunActiveError while another run holds it.
 */
export async function assertSlotFree(
  slot: DeckRunSlot,
  runId: string,
  now: number,
): Promise<void> {
  const held = await slot.read();
  if (held && held.runId !== runId && now - held.heartbeatAt < ABANDONED_MS) {
    throw new DeckRunActiveError(held);
  }
}

/**
 * Claims the person's slot for a new run.
 *
 * @throws DeckRunActiveError while another run holds it.
 */
export async function claimSlot(
  slot: DeckRunSlot,
  record: DeckRunSlotRecord,
  now: number,
): Promise<void> {
  const held = await slot.read();
  if (
    held &&
    held.runId !== record.runId &&
    now - held.heartbeatAt < ABANDONED_MS
  ) {
    throw new DeckRunActiveError(held);
  }
  await slot.write(record);
}

/**
 * Waits for work, or for a stop, whichever comes first. The pipeline only
 * looks at its signal between steps; a stopped job does not wait for that.
 */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const upcomingSteps = (): DeckJobStep[] =>
  NATIVE_PDF_STEPS.map((step) => ({ id: step.id, status: 'upcoming' }));

/**
 * Runs (or continues) a job until it is done, fails or is stopped.
 *
 * @param state - The job as stored; batches in `pieces` are not repeated.
 * @param store - The run's folder, with its key.
 * @param user - The person, for usage records.
 * @param slot - The person's slot, kept alive and released at the end.
 * @returns The final state, also stored.
 */
async function drive(
  initial: DeckJobState,
  store: NativeRunStore,
  user: Session['user'],
  slot: DeckRunSlot,
  deps: DeckJobDeps,
  abort: AbortController,
): Promise<DeckJobState> {
  let state: DeckJobState = { ...initial };
  // Replaced once if the deck has to be repaired.
  let request = state.request;

  // Writes are kept in order: a heartbeat never overtakes a newer state.
  let writing: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = { ...state, heartbeatAt: deps.now() };
    state = snapshot;
    writing = writing
      .then(() => store.putJob(snapshot))
      .catch((error) => {
        console.warn('[deckRunJob] Could not save the job state:', error);
      });
    return writing;
  };
  const beat = async () => {
    // A stop may have been asked for through another instance.
    const stop = await store.stopRequested().catch(() => false);
    if (stop && !abort.signal.aborted) {
      state = { ...state, stopRequested: true };
      abort.abort(new Error('Stopped'));
    }
    await save();
    await slot
      .write({
        runId: state.runId,
        backend: state.backend,
        sourceName: request.sourceName,
        heartbeatAt: deps.now(),
      })
      .catch(() => undefined);
  };
  const timer = setInterval(() => void beat(), deps.heartbeatMs);

  try {
    let document = await store.get(request.sourceId);
    const usage = new WorkflowUsageCollector({
      user,
      action: 'native-deck-translate',
      conversationId: request.conversationId,
    });
    for (
      let index = state.pieces.length;
      index < request.batches.length;
      index += 1
    ) {
      abort.signal.throwIfAborted();
      state = {
        ...state,
        current: { part: index + 1, steps: upcomingSteps() },
      };
      await save();
      const translateBatch = () =>
        untilStopped(
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
            brief: state.brief ?? request.brief,
            signal: abort.signal,
            usage,
            onQueue: (ahead) => {
              if (state.current && state.current.queueAhead !== ahead) {
                state = {
                  ...state,
                  current: { ...state.current, queueAhead: ahead },
                };
                void save();
              }
            },
            onStep: (event) => {
              if (!state.current) return;
              const record = event as NativePdfStepRecord;
              state = {
                ...state,
                current: {
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
              };
              void save();
            },
          }),
          abort.signal,
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
        document = await deps.repair(document, request.format, abort.signal);
        const repairedSource = await store.put(document, 'pptx');
        request = {
          ...request,
          sourceId: repairedSource.id,
          format: 'pptx',
          repaired: true,
        };
        state = { ...state, request };
        await save();
        result = await translateBatch();
      }
      const {
        pdf,
        outputs,
        unitsFile,
        document: translated,
        ...report
      } = result;
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
      state = {
        ...state,
        pieces: [...state.pieces, piece],
        brief: report.brief,
        current: undefined,
      };
      await save();
    }

    // Several batches become one document; one batch already is.
    if (state.pieces.length > 1 && !state.assembled) {
      abort.signal.throwIfAborted();
      const unitsFiles = await Promise.all(
        state.pieces.map((piece) => store.get(piece.unitsId)),
      );
      const translations: Record<string, string> = {};
      for (const piece of state.pieces) {
        for (const unit of piece.units) {
          if (unit.translation !== null)
            translations[unit.id] = unit.translation;
        }
      }
      const styles = Object.assign(
        {},
        ...state.pieces.map((piece) => piece.styles ?? {}),
      );
      const {
        pdf,
        outputs,
        exports: _exports,
        unitsFile,
        document: translated,
        ...rendered
      } = await untilStopped(
        deps.rerender({
          document,
          format: request.format,
          unitsFiles,
          translations,
          styles,
          language: state.brief?.language?.code,
          // Every slide's picture is already stored with its batch.
          imagePages: [],
          checkPages: [],
          maxDocumentPages: deps.maxDocumentPages,
          instructions: {},
          modelId: request.modelId,
          usage,
          signal: abort.signal,
          onQueue: (ahead) => {
            state = {
              ...state,
              current: {
                part: request.batches.length,
                steps: [],
                queueAhead: ahead,
              },
            };
            void save();
          },
        }),
        abort.signal,
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
      state = {
        ...state,
        current: undefined,
        assembled: { ...rendered, ...stored, unitsId: units.id },
      };
    }
    state = { ...state, status: 'done', current: undefined };
  } catch (error) {
    const stopped = abort.signal.aborted || state.stopRequested === true;
    if (stopped) state = { ...state, stopRequested: true };
    if (!stopped) console.error('[deckRunJob] Failed:', error);
    state = {
      ...state,
      status: stopped ? 'stopped' : 'failed',
      current: undefined,
      ...(stopped
        ? {}
        : {
            error:
              error instanceof Error
                ? error.message
                : 'The presentation could not be translated',
          }),
    };
  } finally {
    clearInterval(timer);
    await save();
    await slot.release(state.runId).catch(() => undefined);
  }
  return state;
}

/** Starts driving a job in this process unless it already is. */
function launch(
  state: DeckJobState,
  store: NativeRunStore,
  user: Session['user'],
  slot: DeckRunSlot,
  deps: DeckJobDeps,
): void {
  const jobs = runningHere();
  if (jobs.has(state.runId)) return;
  const abort = new AbortController();
  const done = drive(state, store, user, slot, deps, abort).finally(() =>
    jobs.delete(state.runId),
  );
  jobs.set(state.runId, { done, abort });
}

/**
 * Starts a deck run in the background.
 *
 * @param input - Where the run is, what to translate, and the person.
 * @returns The job's first state; the job goes on after this returns.
 * @throws DeckRunActiveError while the person has another run going.
 */
export async function startDeckJob(input: {
  store: NativeRunStore;
  slot: DeckRunSlot;
  user: Session['user'];
  request: DeckJobRequest;
  deps?: Partial<DeckJobDeps>;
}): Promise<DeckJobState> {
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const { runId, backend } = input.store.location;
  const now = deps.now();
  // The run's own earlier job, still going, holds it too.
  const earlier = await readDeckJob(input.store).catch(() => null);
  if (
    isRunningHere(runId) ||
    (earlier && isActive(earlier) && !isStalled(earlier, now))
  ) {
    throw new DeckRunActiveError({
      runId,
      backend,
      sourceName: earlier?.request.sourceName ?? input.request.sourceName,
      heartbeatAt: earlier?.heartbeatAt ?? now,
    });
  }
  await claimSlot(
    input.slot,
    { runId, backend, sourceName: input.request.sourceName, heartbeatAt: now },
    now,
  );
  const state: DeckJobState = {
    version: DECK_JOB_VERSION,
    jobId: randomUUID(),
    runId,
    backend,
    request: input.request,
    status: 'running',
    pieces: [],
    current: { part: 1, steps: upcomingSteps() },
    startedAt: now,
    heartbeatAt: now,
    resumes: 0,
  };
  await input.store.clearStop();
  await input.store.putJob(state);
  launch(state, input.store, input.user, input.slot, deps);
  return state;
}

/**
 * Picks up a stalled job again (THE JOB CONVENTION): it continues with the
 * first batch not finished.
 *
 * @param state - The stored state; must be stalled.
 * @returns The state as resumed.
 * @throws DeckRunActiveError when the person started another run meanwhile.
 */
export async function resumeDeckJob(input: {
  store: NativeRunStore;
  slot: DeckRunSlot;
  user: Session['user'];
  state: DeckJobState;
  deps?: Partial<DeckJobDeps>;
}): Promise<DeckJobState> {
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const now = deps.now();
  if (!isStalled(input.state, now)) return input.state;
  await claimSlot(
    input.slot,
    {
      runId: input.state.runId,
      backend: input.state.backend,
      sourceName: input.state.request.sourceName,
      heartbeatAt: now,
    },
    now,
  );
  const state: DeckJobState = {
    ...input.state,
    heartbeatAt: now,
    resumes: input.state.resumes + 1,
    current: undefined,
  };
  await input.store.putJob(state);
  launch(state, input.store, input.user, input.slot, deps);
  return state;
}

/**
 * Asks a running job to stop (THE JOB CONVENTION). The instance running it
 * stops at its next heartbeat; one running here stops at once.
 *
 * @returns The state with the stop recorded.
 */
export async function stopDeckJob(
  store: NativeRunStore,
  state: DeckJobState,
): Promise<DeckJobState> {
  if (!isActive(state)) return state;
  const stopping = { ...state, stopRequested: true };
  await store.requestStop();
  runningHere().get(state.runId)?.abort.abort(new Error('Stopped'));
  return stopping;
}
