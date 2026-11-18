'use client';

import {
  RunAccess,
  RunLockedError,
  RunMissingError,
  deleteRun,
  loadRunRecord,
  runFilesInUse,
  saveRunRecord,
  syncRun,
} from '@/client/services/workflows/nativeRunStorage';

import { FormattedDocumentRun } from '@/lib/utils/shared/translation/formattedDocument';
import {
  RUN_KEEP_ALIVE_INTERVAL_MS,
  RUN_SAVE_DELAY_MS,
} from '@/lib/utils/shared/translation/nativeRunStorage';

/**
 * The runs this browser tab has open, one session per run.
 *
 * A run is held in memory ONCE, here, however many parts of the screen show
 * it: the workspace can be mounted more than once for a conversation, and a
 * copy per mount would have each loading, saving and overwriting the other.
 * Components subscribe to a session (see useFormattedRunStorage) and change
 * the run only through it.
 *
 * SAVING: a change is saved at once when the run's files changed, otherwise
 * after RUN_SAVE_DELAY_MS without further changes; a save that fails is
 * tried again, up to {@link SAVE_ATTEMPTS} times.
 *
 * KEEPING ALIVE: opening a run only asks when it expires. Changing it (or
 * `keep`) touches its files, at most every RUN_KEEP_ALIVE_INTERVAL_MS, and
 * deletes files an earlier render left behind.
 */

/**
 * Why a stored run cannot be shown:
 *  - `missing`: its files are gone (expired from app storage, or deleted).
 *  - `no-key` / `other-key`: it is encrypted and this device cannot read it.
 *  - `failed`: it could not be loaded; trying again may work.
 */
export type RunProblem = 'missing' | 'no-key' | 'other-key' | 'failed';

/** What a session shows; replaced, never changed, so it can be compared. */
export interface RunSessionState {
  /** The run, once it is in memory. */
  run?: FormattedDocumentRun;
  /** Why there is no run; null while loading or once there is one. */
  problem: RunProblem | null;
  /** The last save did not reach storage. */
  saveFailed: boolean;
  /** A keep request is in flight. */
  keeping: boolean;
  /** When app storage deletes the run, once asked; null where nothing expires. */
  expiresAt?: string | null;
}

/** Times a failed save is attempted before waiting for the next change. */
export const SAVE_ATTEMPTS = 3;
/** Wait before a failed save is tried again. */
export const SAVE_RETRY_DELAY_MS = 5000;
/** Sessions kept in memory; the least recently opened is dropped first. */
const MAX_SESSIONS = 6;

const LOADING: RunSessionState = {
  problem: null,
  saveFailed: false,
  keeping: false,
};

const problemOf = (error: unknown): RunProblem => {
  if (error instanceof RunMissingError) return 'missing';
  if (error instanceof RunLockedError) return error.reason;
  return 'failed';
};

const filesKey = (run: FormattedDocumentRun): string =>
  runFilesInUse(run).sort().join(',');

class RunSession {
  state: RunSessionState = LOADING;
  private readonly listeners = new Set<() => void>();
  /** What storage is known to hold. */
  private savedRun: FormattedDocumentRun | null = null;
  private syncedFiles = '';
  private lastKeepAlive = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failedSaves = 0;
  private loading: AbortController | null = null;

  constructor(readonly access: RunAccess) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(change: Partial<RunSessionState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Reads the run from storage, and asks when it expires. */
  load(): void {
    this.loading?.abort();
    const abort = new AbortController();
    this.loading = abort;
    this.set({ problem: null });
    void (async () => {
      try {
        const record = await loadRunRecord(this.access, abort.signal);
        if (abort.signal.aborted) return;
        this.savedRun = record;
        this.syncedFiles = filesKey(record);
        this.set({ run: record });
        // Asked, not touched: looking at a run does not extend it.
        const { expiresAt } = await syncRun(
          this.access,
          runFilesInUse(record),
          false,
        );
        this.set({ expiresAt: expiresAt ?? null });
      } catch (error) {
        if (abort.signal.aborted) return;
        this.set({ problem: problemOf(error), run: undefined });
      }
    })();
  }

  /** Takes a run that was just made, and saves it. */
  adopt(run: FormattedDocumentRun): void {
    this.loading?.abort();
    this.set({ run, problem: null });
    this.schedule(true);
  }

  /** Applies a change to the run and saves it. */
  update(change: (run: FormattedDocumentRun) => FormattedDocumentRun): void {
    const current = this.state.run;
    if (!current) return;
    const next = change(current);
    if (next === current) return;
    this.set({ run: next });
    this.failedSaves = 0;
    this.schedule(filesKey(next) !== this.syncedFiles);
  }

  private schedule(immediately: boolean, delay = RUN_SAVE_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.persist();
      },
      immediately ? 0 : delay,
    );
  }

  /** Saves now what was waiting for its quiet period. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    void this.persist();
  }

  /**
   * Saves the run as it now stands, then keeps its files alive when that
   * is due, forced, or its files changed.
   */
  async persist(force = false): Promise<void> {
    const run = this.state.run;
    if (!run) return;
    try {
      if (this.savedRun !== run) {
        await saveRunRecord(this.access, run);
        this.savedRun = run;
      }
      const files = filesKey(run);
      const due = Date.now() - this.lastKeepAlive > RUN_KEEP_ALIVE_INTERVAL_MS;
      if (force || due || files !== this.syncedFiles) {
        const { expiresAt } = await syncRun(this.access, runFilesInUse(run));
        this.syncedFiles = files;
        this.lastKeepAlive = Date.now();
        this.set({ expiresAt: expiresAt ?? null });
      }
      this.failedSaves = 0;
      if (this.state.saveFailed) this.set({ saveFailed: false });
    } catch (error) {
      if (error instanceof RunMissingError) {
        this.set({ problem: 'missing', run: undefined });
        return;
      }
      this.failedSaves += 1;
      this.set({ saveFailed: true });
      if (this.failedSaves < SAVE_ATTEMPTS && !this.timer) {
        this.schedule(false, SAVE_RETRY_DELAY_MS);
      }
    }
  }

  /** Keeps the run's files for another retention period, now. */
  async keep(): Promise<void> {
    if (!this.state.run || this.state.keeping) return;
    this.set({ keeping: true });
    try {
      await this.persist(true);
    } finally {
      this.set({ keeping: false });
    }
  }

  /** Stops everything in flight; the session is being dropped. */
  close(): void {
    this.loading?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const sessions = new Map<string, RunSession>();

/** Drops the sessions opened longest ago that have nothing left to save. */
function trim(): void {
  for (const [runId, session] of sessions) {
    if (sessions.size <= MAX_SESSIONS) return;
    session.flush();
    sessions.delete(runId);
  }
}

/**
 * The session of a stored run, loading it when this tab has not opened it.
 *
 * @param access - Where the run is stored.
 */
export function openRunSession(access: RunAccess): RunSession {
  let session = sessions.get(access.runId);
  if (!session) {
    session = new RunSession(access);
    sessions.set(access.runId, session);
    session.load();
    trim();
  }
  return session;
}

/**
 * Starts the session of a run that was just made, or replaces the run of
 * one that is open (more pages were added to it).
 *
 * @param access - Where the run's files were written.
 * @param run - The run.
 */
export function adoptRun(access: RunAccess, run: FormattedDocumentRun): void {
  let session = sessions.get(access.runId);
  if (!session) {
    session = new RunSession(access);
    sessions.set(access.runId, session);
    trim();
  }
  session.adopt(run);
}

/** The open session of a run, if this tab has one. */
export function findRunSession(runId: string): RunSession | undefined {
  return sessions.get(runId);
}

/**
 * Closes a run's session.
 *
 * @param access - The run.
 * @param remove - Also delete its files from storage.
 */
export function dropRunSession(access: RunAccess, remove: boolean): void {
  sessions.get(access.runId)?.close();
  sessions.delete(access.runId);
  if (remove) void deleteRun(access);
}

/** Saves what every open session still owes (the page is going away). */
export function flushRunSessions(): void {
  for (const session of sessions.values()) session.flush();
}

/** Forgets every session without saving; for tests. */
export function resetRunSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

export type { RunSession };
