/**
 * Work the server does in the background for a person: started by one
 * request, followed by later ones, going on whether or not a page is open.
 * A JOB KIND says what is done; this runner does the rest.
 *
 * THE JOB CONVENTION (stated once; every kind, route and test cites it):
 *  - STATE lives in the job's own store (a JobStore: for a translation run,
 *    the run's folder, encrypted with the run), so it is as private as the
 *    job's files and every instance can read it.
 *  - A job is RUNNING while some instance writes a heartbeat into its state
 *    at least every `heartbeatMs`. A running job whose heartbeat is older
 *    than STALLED_MS has no one running it (a restart, a crash): the next
 *    read of its progress picks it up again (`resumeJob`). A kind must make
 *    its work resumable: what is finished is stored before what follows
 *    starts, and is not done (or charged) again.
 *  - A STOP is a marker of its own in the store, so no progress write can
 *    overwrite it; the instance running the job sees it with its next
 *    heartbeat and stops. What was finished is kept.
 *  - ACTIVE JOBS PER PERSON AND KIND are limited (`JobKind.limitPerPerson`):
 *    the person's slots name their running jobs, and a start is refused
 *    while the limit's worth of other jobs of the kind was heard from
 *    within ABANDONED_MS.
 */
import { randomUUID } from 'crypto';

/** How often a running job writes its heartbeat. */
export const HEARTBEAT_MS = 15_000;
/** A running job not heard from for this long has no one running it. */
export const STALLED_MS = 60_000;
/** A slot frees when its job has not been heard from for this long. */
export const ABANDONED_MS = 15 * 60_000;

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped';

/** What every job's state holds, whatever its kind. */
export interface JobStateBase {
  /** The kind's state version; a state of another version is not read. */
  version: number;
  jobId: string;
  status: JobStatus;
  startedAt: number;
  heartbeatAt: number;
  /** Times the job was picked up again after it stalled. */
  resumes: number;
  stopRequested?: boolean;
  error?: string;
}

/** Where a job's state and its stop marker are kept. */
export interface JobStore {
  getJob(): Promise<unknown | null>;
  putJob(state: unknown): Promise<void>;
  stopRequested(): Promise<boolean>;
  requestStop(): Promise<void>;
  clearStop(): Promise<void>;
}

/** One of a person's running jobs, as their slots name it. */
export interface JobSlotRecord {
  /** The job's key (unique within its kind, e.g. a run id). */
  key: string;
  /** What the person knows the job by (a file name). */
  label: string;
  heartbeatAt: number;
  /** Anything else the kind keeps with it. */
  data?: Record<string, unknown>;
}

/** A person's slots for one kind of job. */
export interface JobSlots {
  read(): Promise<JobSlotRecord[]>;
  /** Adds the record, or replaces the one with its key. */
  write(record: JobSlotRecord): Promise<void>;
  /** Frees the slot holding `key`, if any. */
  release(key: string): Promise<void>;
}

/** A start refused because the person's limit for the kind is reached. */
export class JobActiveError extends Error {
  readonly code = 'JOB_ACTIVE';
  constructor(
    readonly kind: string,
    /** The person's job in the way. */
    readonly active: JobSlotRecord,
  ) {
    super(
      `"${active.label}" is still running. Wait for it to finish, or stop it, before starting another.`,
    );
    this.name = 'JobActiveError';
  }
}

/** What a kind's work is given while it runs. */
export interface JobRun<S extends JobStateBase> {
  /** Aborted when the job is stopped. */
  readonly signal: AbortSignal;
  /** The state as it is now. */
  state(): S;
  /** Changes the state (not yet saved). */
  update(change: Partial<S> | ((state: S) => S)): S;
  /** Saves the state with a fresh heartbeat; saves stay in order. */
  save(): Promise<void>;
  /** Waits for work, or for a stop, whichever comes first. */
  untilStopped<T>(work: Promise<T>): Promise<T>;
}

/**
 * A kind of background job.
 *
 * @typeParam R - What it is asked to do (fixed when it starts).
 * @typeParam S - Its state.
 * @typeParam C - What its work needs from the world (stores, a person).
 */
export interface JobKind<R, S extends JobStateBase & { request: R }, C> {
  /** Names the kind in slots, logs and errors. */
  kind: string;
  version: number;
  limitPerPerson: number;
  /** What the person knows a job by. */
  label(request: R): string;
  /** Kind-specific fields of a new job's state. */
  initial(request: R, context: C): Omit<S, keyof JobStateBase | 'request'>;
  /** Clears what only means something while the job runs (at its end and
   * when it is picked up again). */
  settle(state: S): S;
  /** The message a failure is recorded with when it has none. */
  failureMessage: string;
  /** Does the work; returns when it is done. Throws to fail. */
  run(job: JobRun<S>, context: C): Promise<void>;
}

/** Timing; replaced in tests. */
export interface JobClock {
  now: () => number;
  heartbeatMs: number;
}

const DEFAULT_CLOCK: JobClock = { now: Date.now, heartbeatMs: HEARTBEAT_MS };

// Jobs this process is running, by kind and key. On globalThis because the
// dev server reloads modules.
const JOBS_KEY = Symbol.for('ai-assistant.background-jobs');
interface RunningJob {
  done: Promise<unknown>;
  abort: AbortController;
}
type JobHolder = { [JOBS_KEY]?: Map<string, RunningJob> };

function runningHere(): Map<string, RunningJob> {
  const holder = globalThis as JobHolder;
  holder[JOBS_KEY] ??= new Map();
  return holder[JOBS_KEY];
}

const jobName = (kind: string, key: string) => `${kind}:${key}`;

/** Whether this process is running the job. */
export function isRunningHere(kind: string, key: string): boolean {
  return runningHere().has(jobName(kind, key));
}

/** The job's promise in this process, for tests and shutdown. */
export function jobInProcess<S>(
  kind: string,
  key: string,
): Promise<S> | undefined {
  return runningHere().get(jobName(kind, key))?.done as Promise<S> | undefined;
}

/** Whether a job's state says someone should be running it. */
export function isActive(state: Pick<JobStateBase, 'status'>): boolean {
  return state.status === 'running';
}

/**
 * Whether a running job has no one running it (THE JOB CONVENTION).
 *
 * @param state - The stored state.
 * @param now - The time now.
 */
export function isStalled(
  kind: string,
  key: string,
  state: Pick<JobStateBase, 'status' | 'heartbeatAt'>,
  now: number,
): boolean {
  return (
    isActive(state) &&
    now - state.heartbeatAt > STALLED_MS &&
    !isRunningHere(kind, key)
  );
}

/** Reads a job's state, or null when there is none of the kind's version. */
export async function readJob<S extends JobStateBase>(
  kind: Pick<JobKind<unknown, never, unknown>, 'version'>,
  store: JobStore,
): Promise<S | null> {
  const state = (await store.getJob()) as S | null;
  if (!state || state.version !== kind.version) return null;
  return state;
}

/**
 * Checks the person's slots without taking one, so nothing is stored for
 * a job that would be refused.
 *
 * @throws JobActiveError when the limit is reached by other jobs.
 */
export async function assertSlotFree(
  kind: Pick<JobKind<unknown, never, unknown>, 'kind' | 'limitPerPerson'>,
  slots: JobSlots,
  key: string,
  now: number,
): Promise<void> {
  const others = (await slots.read()).filter(
    (record) => record.key !== key && now - record.heartbeatAt < ABANDONED_MS,
  );
  if (others.length >= kind.limitPerPerson) {
    throw new JobActiveError(kind.kind, others[0]);
  }
}

/**
 * Takes a slot for a job.
 *
 * @throws JobActiveError when the limit is reached by other jobs.
 */
export async function claimSlot(
  kind: Pick<JobKind<unknown, never, unknown>, 'kind' | 'limitPerPerson'>,
  slots: JobSlots,
  record: JobSlotRecord,
  now: number,
): Promise<void> {
  await assertSlotFree(kind, slots, record.key, now);
  await slots.write(record);
}

/** Runs (or continues) a job until it is done, fails or is stopped. */
async function drive<R, S extends JobStateBase & { request: R }, C>(
  kind: JobKind<R, S, C>,
  key: string,
  initial: S,
  input: { store: JobStore; slots: JobSlots; context: C; clock: JobClock },
  abort: AbortController,
): Promise<S> {
  const { store, slots, clock } = input;
  let state: S = { ...initial };

  // Writes are kept in order: a heartbeat never overtakes a newer state.
  let writing: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = { ...state, heartbeatAt: clock.now() };
    state = snapshot;
    writing = writing
      .then(() => store.putJob(snapshot))
      .catch((error) => {
        console.warn(`[${kind.kind}] Could not save the job state:`, error);
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
    await slots
      .write({
        key,
        label: kind.label(state.request),
        heartbeatAt: clock.now(),
      })
      .catch(() => undefined);
  };
  const timer = setInterval(() => void beat(), clock.heartbeatMs);

  const run: JobRun<S> = {
    signal: abort.signal,
    state: () => state,
    update: (change) => {
      state =
        typeof change === 'function' ? change(state) : { ...state, ...change };
      return state;
    },
    save,
    untilStopped: (work) => untilStopped(work, abort.signal),
  };

  try {
    await kind.run(run, input.context);
    state = kind.settle({ ...state, status: 'done' });
  } catch (error) {
    const stopped = abort.signal.aborted || state.stopRequested === true;
    if (!stopped) console.error(`[${kind.kind}] Failed:`, error);
    state = kind.settle({
      ...state,
      status: stopped ? 'stopped' : 'failed',
      ...(stopped
        ? { stopRequested: true }
        : {
            error:
              error instanceof Error && error.message
                ? error.message
                : kind.failureMessage,
          }),
    });
  } finally {
    clearInterval(timer);
    await save();
    await slots.release(key).catch(() => undefined);
  }
  return state;
}

/**
 * Waits for work, or for a stop, whichever comes first. Work that only
 * looks at its signal between steps is not waited for once stopped.
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

/** Starts driving a job in this process unless it already is. */
function launch<R, S extends JobStateBase & { request: R }, C>(
  kind: JobKind<R, S, C>,
  key: string,
  state: S,
  input: { store: JobStore; slots: JobSlots; context: C; clock: JobClock },
): void {
  const jobs = runningHere();
  const name = jobName(kind.kind, key);
  if (jobs.has(name)) return;
  const abort = new AbortController();
  const done = drive(kind, key, state, input, abort).finally(() =>
    jobs.delete(name),
  );
  jobs.set(name, { done, abort });
}

/** Where a job lives and what it runs with. */
export interface JobPlace<C> {
  store: JobStore;
  slots: JobSlots;
  /** Unique within the kind (a run id). */
  key: string;
  context: C;
  clock?: Partial<JobClock>;
}

/**
 * Starts a job in the background.
 *
 * @returns The job's first state, stored; the work goes on after this.
 * @throws JobActiveError while the same job runs, or the person's limit
 *   for the kind is reached.
 */
export async function startJob<R, S extends JobStateBase & { request: R }, C>(
  kind: JobKind<R, S, C>,
  place: JobPlace<C>,
  request: R,
): Promise<S> {
  const clock = { ...DEFAULT_CLOCK, ...place.clock };
  const now = clock.now();
  // The job's own earlier run, still going, holds its place too.
  const earlier = await readJob<S>(kind, place.store).catch(() => null);
  if (
    isRunningHere(kind.kind, place.key) ||
    (earlier &&
      isActive(earlier) &&
      !isStalled(kind.kind, place.key, earlier, now))
  ) {
    throw new JobActiveError(kind.kind, {
      key: place.key,
      label: kind.label(earlier?.request ?? request),
      heartbeatAt: earlier?.heartbeatAt ?? now,
    });
  }
  await claimSlot(
    kind,
    place.slots,
    { key: place.key, label: kind.label(request), heartbeatAt: now },
    now,
  );
  const state = {
    ...kind.initial(request, place.context),
    version: kind.version,
    jobId: randomUUID(),
    request,
    status: 'running',
    startedAt: now,
    heartbeatAt: now,
    resumes: 0,
  } as S;
  await place.store.clearStop();
  await place.store.putJob(state);
  launch(kind, place.key, state, { ...place, clock });
  return state;
}

/**
 * Picks up a stalled job again (THE JOB CONVENTION). A job that is not
 * stalled is returned as it is.
 *
 * @throws JobActiveError when the person's limit was reached meanwhile.
 */
export async function resumeJob<R, S extends JobStateBase & { request: R }, C>(
  kind: JobKind<R, S, C>,
  place: JobPlace<C>,
  stored: S,
): Promise<S> {
  const clock = { ...DEFAULT_CLOCK, ...place.clock };
  const now = clock.now();
  if (!isStalled(kind.kind, place.key, stored, now)) return stored;
  await claimSlot(
    kind,
    place.slots,
    { key: place.key, label: kind.label(stored.request), heartbeatAt: now },
    now,
  );
  const state = kind.settle({
    ...stored,
    heartbeatAt: now,
    resumes: stored.resumes + 1,
  });
  await place.store.putJob(state);
  launch(kind, place.key, state, { ...place, clock });
  return state;
}

/**
 * Asks a running job to stop (THE JOB CONVENTION). The instance running it
 * stops at its next heartbeat; one running here stops at once.
 *
 * @returns The state with the stop recorded.
 */
export async function stopJob<S extends JobStateBase>(
  kind: Pick<JobKind<unknown, never, unknown>, 'kind'>,
  key: string,
  store: JobStore,
  state: S,
): Promise<S> {
  if (!isActive(state)) return state;
  await store.requestStop();
  runningHere().get(jobName(kind.kind, key))?.abort.abort(new Error('Stopped'));
  return { ...state, stopRequested: true };
}
