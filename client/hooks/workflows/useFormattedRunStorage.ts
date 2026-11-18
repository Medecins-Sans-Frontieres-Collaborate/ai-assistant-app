'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import {
  RunProblem,
  RunSessionState,
  adoptRun,
  dropRunSession,
  findRunSession,
  flushRunSessions,
  openRunSession,
} from '@/client/services/workflows/nativeRunSession';
import { RunAccess } from '@/client/services/workflows/nativeRunStorage';

import { FormattedDocumentRun } from '@/lib/utils/shared/translation/formattedDocument';
import { NativeRunRef } from '@/lib/utils/shared/translation/nativeRunStorage';

export type FormattedRunProblem = RunProblem;

interface UseFormattedRunStorageInput {
  /** The reference kept in workflow state, if a run has finished. */
  runRef: NativeRunRef | undefined;
  /** Replaces the reference in workflow state; undefined forgets the run. */
  setRunRef: (ref: NativeRunRef | undefined) => void;
}

const NO_RUN: RunSessionState = {
  problem: null,
  saveFailed: false,
  keeping: false,
};
const noSubscription = () => () => undefined;

/**
 * Connects a workspace to the stored run its workflow state points at.
 *
 * Workflow state holds only a NativeRunRef (see nativeRunStorage.ts). The
 * run itself lives in a session shared by everything in this tab that shows
 * it (see nativeRunSession.ts, which also says when it is saved and kept
 * alive); this hook subscribes to that session and passes changes to it.
 */
export function useFormattedRunStorage(input: UseFormattedRunStorageInput) {
  const { runRef, setRunRef } = input;
  // The latest values, for callbacks that outlive a render.
  const refNow = useRef(runRef);
  const setRefNow = useRef(setRunRef);
  useEffect(() => {
    refNow.current = runRef;
    setRefNow.current = setRunRef;
  });

  const runId = runRef?.runId;
  // Opening is idempotent: the first caller starts the load.
  const session = runRef ? openRunSession(runRef) : undefined;
  const state = useSyncExternalStore(
    session ? (listener) => session.subscribe(listener) : noSubscription,
    () => session?.state ?? NO_RUN,
    () => NO_RUN,
  );

  // What the session learned about the expiry goes into the reference,
  // where it is known without asking storage again.
  const { expiresAt } = state;
  useEffect(() => {
    const current = refNow.current;
    if (!current || current.runId !== runId || expiresAt === undefined) return;
    if ((current.expiresAt ?? null) === expiresAt) return;
    const { expiresAt: _previous, ...rest } = current;
    setRefNow.current(expiresAt ? { ...rest, expiresAt } : rest);
  }, [runId, expiresAt]);

  // Save what is pending when the workspace or the page goes away.
  useEffect(() => {
    window.addEventListener('pagehide', flushRunSessions);
    return () => {
      window.removeEventListener('pagehide', flushRunSessions);
      flushRunSessions();
    };
  }, []);

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
      adoptRun(access, next);
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
      if (previous && previous.runId !== access.runId) {
        dropRunSession(previous, true);
      }
    },
    [],
  );

  /** Applies a change to the run and saves it. */
  const updateRun = useCallback(
    (update: (run: FormattedDocumentRun) => FormattedDocumentRun) => {
      const ref = refNow.current;
      if (ref) findRunSession(ref.runId)?.update(update);
    },
    [],
  );

  /** Keeps the run's files for another retention period, now. */
  const keep = useCallback(async () => {
    const ref = refNow.current;
    if (ref) await findRunSession(ref.runId)?.keep();
  }, []);

  /**
   * Forgets the run.
   *
   * @param remove - Also delete its files from storage.
   */
  const discard = useCallback((remove: boolean) => {
    const ref = refNow.current;
    refNow.current = undefined;
    setRefNow.current(undefined);
    if (ref) dropRunSession(ref, remove);
  }, []);

  /** Tries loading the run again after a failure. */
  const retry = useCallback(() => {
    const ref = refNow.current;
    if (ref) findRunSession(ref.runId)?.load();
  }, []);

  return {
    run: state.run,
    /** The run is being read from storage. */
    loading: !!runRef && !state.run && !state.problem,
    problem: runRef ? state.problem : null,
    /** The last save did not reach storage yet; it is tried again. */
    saveFailed: state.saveFailed,
    keeping: state.keeping,
    setRun,
    updateRun,
    keep,
    discard,
    retry,
  };
}

export type FormattedRunStorage = ReturnType<typeof useFormattedRunStorage>;
