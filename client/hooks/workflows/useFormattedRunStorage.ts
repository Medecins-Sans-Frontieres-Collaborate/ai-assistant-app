'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
  NativeRunRef,
  RUN_KEEP_ALIVE_INTERVAL_MS,
  RUN_SAVE_DELAY_MS,
} from '@/lib/utils/shared/translation/nativeRunStorage';

/**
 * Why a stored run cannot be shown:
 *  - `missing`: its files are gone (expired from app storage, or deleted).
 *  - `no-key` / `other-key`: it is encrypted and this device cannot read it.
 *  - `failed`: it could not be loaded; trying again may work.
 */
export type FormattedRunProblem = 'missing' | 'no-key' | 'other-key' | 'failed';

interface UseFormattedRunStorageInput {
  /** The reference kept in workflow state, if a run has finished. */
  runRef: NativeRunRef | undefined;
  /** Replaces the reference in workflow state; undefined forgets the run. */
  setRunRef: (ref: NativeRunRef | undefined) => void;
}

const problemOf = (error: unknown): FormattedRunProblem => {
  if (error instanceof RunMissingError) return 'missing';
  if (error instanceof RunLockedError) return error.reason;
  return 'failed';
};

const filesKey = (run: FormattedDocumentRun): string =>
  runFilesInUse(run).sort().join(',');

/**
 * Holds a formatted translation run in memory and keeps it in storage.
 *
 * Workflow state holds only a NativeRunRef (see nativeRunStorage.ts); the
 * run itself is loaded from its record when the workspace opens, and every
 * change is saved back: at once when the run's files changed, otherwise
 * after {@link RUN_SAVE_DELAY_MS} without further changes.
 *
 * KEEPING A RUN ALIVE: opening a run only asks when it expires, so an
 * expiry warning can be shown. Changing it (or `keep`) touches its files,
 * at most every {@link RUN_KEEP_ALIVE_INTERVAL_MS}, and deletes files an
 * earlier render left behind.
 */
export function useFormattedRunStorage(input: UseFormattedRunStorageInput) {
  const { runRef, setRunRef } = input;
  const [loaded, setLoaded] = useState<{
    runId: string;
    run: FormattedDocumentRun;
  } | null>(null);
  const [problem, setProblem] = useState<{
    runId: string;
    kind: FormattedRunProblem;
  } | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // The latest values, for callbacks and timers that outlive a render.
  const refNow = useRef(runRef);
  const setRefNow = useRef(setRunRef);
  const runNow = useRef<FormattedDocumentRun | null>(null);
  /** The id of the run `runNow` holds. */
  const heldRunId = useRef<string | null>(null);
  useEffect(() => {
    refNow.current = runRef;
    setRefNow.current = setRunRef;
  });
  /** What storage is known to hold: the saved run and the files synced. */
  const saved = useRef<{ run: FormattedDocumentRun | null; files: string }>({
    run: null,
    files: '',
  });
  const lastKeepAlive = useRef(0);
  /** A save waiting for its quiet period, and the run it belongs to. */
  const pendingSave = useRef<{
    timer: ReturnType<typeof setTimeout>;
    access: RunAccess;
  } | null>(null);

  // DEBUG-STORAGE
  useEffect(() => {
    console.warn('[run-storage] mount');
    return () => console.warn('[run-storage] unmount');
  }, []);
  const runId = runRef?.runId;
  const run = loaded && loaded.runId === runId ? loaded.run : undefined;

  /** Writes a newly learned expiry into the reference. */
  const noteExpiry = useCallback((id: string, expiresAt?: string) => {
    const current = refNow.current;
    if (!current || current.runId !== id || current.expiresAt === expiresAt) {
      return;
    }
    const { expiresAt: _old, ...rest } = current;
    setRefNow.current(expiresAt ? { ...rest, expiresAt } : rest);
  }, []);

  /**
   * Saves the run as it now stands, then keeps its files alive when that is
   * due or its files changed.
   */
  const persist = useCallback(
    async (access: RunAccess, force = false) => {
      const current = runNow.current;
      // Only the run this hook holds is saved under its own id.
      if (!current || heldRunId.current !== access.runId) return;
      try {
        if (saved.current.run !== current) {
          await saveRunRecord(access, current);
          saved.current.run = current;
        }
        const files = filesKey(current);
        const due =
          Date.now() - lastKeepAlive.current > RUN_KEEP_ALIVE_INTERVAL_MS;
        if (force || due || files !== saved.current.files) {
          const { expiresAt } = await syncRun(access, runFilesInUse(current));
          saved.current.files = files;
          lastKeepAlive.current = Date.now();
          noteExpiry(access.runId, expiresAt);
        }
        setSaveFailed(false);
      } catch (error) {
        if (error instanceof RunMissingError) {
          setProblem({ runId: access.runId, kind: 'missing' });
        } else {
          setSaveFailed(true);
        }
      }
    },
    [noteExpiry],
  );

  /** Saves now what was waiting for its quiet period. */
  const flushPending = useCallback(() => {
    const pending = pendingSave.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSave.current = null;
    void persist(pending.access);
  }, [persist]);

  // Load the record of a run this hook does not hold yet.
  useEffect(() => {
    const ref = refNow.current;
    if (!ref || !runId || heldRunId.current === runId) return;
    console.warn('[run-storage] load', runId, 'held', heldRunId.current); // DEBUG-STORAGE
    // Another run takes this one's place: what it still owes is saved first.
    flushPending();
    runNow.current = null;
    heldRunId.current = null;
    const abort = new AbortController();
    setProblem(null);
    void (async () => {
      try {
        const record = await loadRunRecord(ref, abort.signal);
        if (abort.signal.aborted) return;
        runNow.current = record;
        heldRunId.current = runId;
        saved.current = { run: record, files: filesKey(record) };
        setLoaded({ runId, run: record });
        // Asked, not touched: looking at a run does not extend it.
        const { expiresAt } = await syncRun(ref, runFilesInUse(record), false);
        noteExpiry(runId, expiresAt);
      } catch (error) {
        if (abort.signal.aborted) return;
        setProblem({ runId, kind: problemOf(error) });
      }
    })();
    return () => abort.abort();
  }, [runId, loadAttempt, noteExpiry, flushPending]);

  // Save what is pending when the workspace goes away.
  useEffect(() => flushPending, [flushPending]);

  const schedule = useCallback(
    (access: RunAccess, immediately: boolean) => {
      if (pendingSave.current) clearTimeout(pendingSave.current.timer);
      const timer = setTimeout(
        () => {
          pendingSave.current = null;
          void persist(access);
        },
        immediately ? 0 : RUN_SAVE_DELAY_MS,
      );
      pendingSave.current = { timer, access };
    },
    [persist],
  );

  /**
   * Stores a finished run (a first batch, or all batches joined) and points
   * workflow state at it. A run this replaces is deleted.
   *
   * @param next - The run.
   * @param access - Where its files were written.
   */
  const setRun = useCallback(
    (next: FormattedDocumentRun, access: RunAccess) => {
      const previous = refNow.current;
      console.warn('[run-storage] setRun', access.runId); // DEBUG-STORAGE
      runNow.current = next;
      heldRunId.current = access.runId;
      if (previous?.runId !== access.runId) {
        saved.current = { run: null, files: '' };
        lastKeepAlive.current = 0;
      }
      setLoaded({ runId: access.runId, run: next });
      setProblem(null);
      const ref: NativeRunRef = {
        runId: access.runId,
        backend: access.backend,
        ...(access.keyId ? { keyId: access.keyId } : {}),
        sourceUrl: next.sourceUrl,
        sourceId: next.sourceId,
        ...(previous?.runId === access.runId && previous.expiresAt
          ? { expiresAt: previous.expiresAt }
          : {}),
      };
      refNow.current = ref;
      setRefNow.current(ref);
      schedule(access, true);
      if (previous && previous.runId !== access.runId) void deleteRun(previous);
    },
    [schedule],
  );

  /** Applies a change to the run and saves it. */
  const updateRun = useCallback(
    (update: (run: FormattedDocumentRun) => FormattedDocumentRun) => {
      const ref = refNow.current;
      const current = runNow.current;
      if (!ref || !current) return;
      const next = update(current);
      if (next === current) return;
      runNow.current = next;
      setLoaded({ runId: ref.runId, run: next });
      schedule(ref, filesKey(next) !== saved.current.files);
    },
    [schedule],
  );

  /** Keeps the run's files for another retention period, now. */
  const keep = useCallback(async () => {
    const ref = refNow.current;
    if (!ref || !runNow.current) return;
    setKeeping(true);
    try {
      await persist(ref, true);
    } finally {
      setKeeping(false);
    }
  }, [persist]);

  /**
   * Forgets the run.
   *
   * @param remove - Also delete its files from storage.
   */
  const discard = useCallback((remove: boolean) => {
    const ref = refNow.current;
    if (pendingSave.current) clearTimeout(pendingSave.current.timer);
    pendingSave.current = null;
    runNow.current = null;
    heldRunId.current = null;
    saved.current = { run: null, files: '' };
    refNow.current = undefined;
    setLoaded(null);
    setProblem(null);
    setRefNow.current(undefined);
    if (ref && remove) void deleteRun(ref);
  }, []);

  /** Tries loading the run again after a failure. */
  const retry = useCallback(() => {
    runNow.current = null;
    heldRunId.current = null;
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const currentProblem =
    problem && problem.runId === runId ? problem.kind : null;
  return {
    run,
    /** The run is being read from storage. */
    loading: !!runRef && !run && !currentProblem,
    problem: currentProblem,
    /** The last save did not reach storage; the next change tries again. */
    saveFailed,
    keeping,
    setRun,
    updateRun,
    keep,
    discard,
    retry,
  };
}

export type FormattedRunStorage = ReturnType<typeof useFormattedRunStorage>;
