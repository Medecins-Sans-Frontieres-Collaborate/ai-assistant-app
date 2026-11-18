'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { RunProblem } from '@/client/services/workflows/nativeRunSession';
import {
  RunLockedError,
  RunMissingError,
  deleteSourceText,
  loadSourceText,
  storeSourceText,
  touchSourceText,
} from '@/client/services/workflows/storedSourceText';

import {
  NativeRunBackend,
  RUN_KEEP_ALIVE_INTERVAL_MS,
} from '@/lib/utils/shared/translation/nativeRunStorage';
import {
  StoredSourceTextRef,
  attachSourceText,
  hasCurrentSourceTextRef,
  isLargeSourceText,
  sourceTextFingerprint,
} from '@/lib/utils/shared/translation/storedSourceText';

import { TranslationWorkflowState } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';

/** Quiet time after the text changes before it is sent to storage. */
export const SOURCE_TEXT_STORE_DELAY_MS = 2000;

// One of each per text, however many workspaces show the conversation: the
// workspace can be mounted more than once (see nativeRunSession.ts).
const loads = new Map<string, Promise<string>>();
const saves = new Map<string, Promise<void>>();
const lastTouch = new Map<string, number>();

/** Forgets what is in flight; for tests. */
export function resetStoredSourceText(): void {
  loads.clear();
  saves.clear();
  lastTouch.clear();
}

const problemOf = (error: unknown): RunProblem => {
  if (error instanceof RunMissingError) return 'missing';
  if (error instanceof RunLockedError) return error.reason;
  return 'failed';
};

const readState = (id: string): TranslationWorkflowState | undefined => {
  const state = useConversationStore
    .getState()
    .conversations.find(
      (conversation) => conversation.id === id,
    )?.workflowState;
  return state?.kind === 'translation' ? state : undefined;
};

/** Changes the conversation's translation state; `edited` marks it as edited. */
function change(
  id: string,
  edited: boolean,
  update: (state: TranslationWorkflowState) => TranslationWorkflowState,
): void {
  const store = useConversationStore.getState();
  const apply = (previous: unknown) => {
    const state = previous as TranslationWorkflowState | undefined;
    return state?.kind === 'translation' ? update(state) : (state as never);
  };
  if (edited) store.updateWorkflowState(id, apply);
  else store.hydrateWorkflowState(id, apply);
}

/** Sets or clears the reference's expiry without marking an edit. */
function noteExpiry(id: string, refId: string, expiresAt?: string): void {
  change(id, false, (state) => {
    const ref = state.sourceTextRef;
    if (!ref || ref.id !== refId || ref.expiresAt === expiresAt) return state;
    const { expiresAt: _previous, ...rest } = ref;
    return {
      ...state,
      sourceTextRef: expiresAt ? { ...rest, expiresAt } : rest,
    };
  });
}

interface UseStoredSourceTextInput {
  conversationId: string;
  /** The conversation's translation state. */
  state: TranslationWorkflowState | undefined;
  /** Where a newly stored text goes. */
  backend: NativeRunBackend;
}

/**
 * Keeps a large source text in storage instead of the browser, following
 * the conventions of storedSourceText.ts:
 *  - a text that has not been fetched yet (`detached`) is loaded and put
 *    into `sourceText`, without marking the conversation as edited;
 *  - a large text that storage does not hold as it now is gets saved,
 *    SOURCE_TEXT_STORE_DELAY_MS after its last change;
 *  - a text that became short again goes back to the browser, and its
 *    stored copy is deleted;
 *  - changes to the conversation keep the stored copy alive, at most every
 *    RUN_KEEP_ALIVE_INTERVAL_MS. Opening it only asks when it expires.
 *
 * Nothing here can lose a text: until storage holds the current one, the
 * browser keeps it.
 */
export function useStoredSourceText(input: UseStoredSourceTextInput) {
  const { conversationId, state, backend } = input;
  const [problem, setProblem] = useState<RunProblem | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [keeping, setKeeping] = useState(false);

  const ref = state?.sourceTextRef;
  const refId = ref?.id;
  const detached = !!ref?.detached;
  const sourceText = state?.sourceText ?? '';
  const backendNow = useRef(backend);
  useEffect(() => {
    backendNow.current = backend;
  });

  // Fetch a text the browser did not keep.
  useEffect(() => {
    const current = readState(conversationId)?.sourceTextRef;
    if (!current?.detached) return;
    let cancelled = false;
    setProblem(null);
    let load = loads.get(current.id);
    if (!load) {
      load = loadSourceText(current).finally(() => loads.delete(current.id));
      loads.set(current.id, load);
    }
    load
      .then(async (text) => {
        change(conversationId, false, (latest) =>
          latest.sourceTextRef?.detached &&
          latest.sourceTextRef.id === current.id
            ? attachSourceText(latest, text)
            : latest,
        );
        // Asked, not touched: looking at a text does not extend it.
        const expiresAt = await touchSourceText(current, false).catch(
          () => current.expiresAt,
        );
        noteExpiry(conversationId, current.id, expiresAt);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(problemOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, refId, detached, attempt]);

  // Save a large text storage does not hold; take back a short one.
  useEffect(() => {
    if (!state || detached) return;
    if (!isLargeSourceText(sourceText)) {
      if (!ref) return;
      change(conversationId, true, (latest) => {
        if (latest.sourceTextRef?.id !== ref.id) return latest;
        const { sourceTextRef: _dropped, ...rest } = latest;
        return rest;
      });
      void deleteSourceText(ref);
      return;
    }
    if (hasCurrentSourceTextRef({ sourceText, sourceTextRef: ref })) return;
    const timer = setTimeout(() => {
      if (saves.has(conversationId)) return;
      const fingerprint = sourceTextFingerprint(sourceText);
      const save = storeSourceText(sourceText, backendNow.current, ref)
        .then((stored) => {
          if (ref && ref.id !== stored.id) void deleteSourceText(ref);
          lastTouch.set(stored.id, Date.now());
          // Kept only if this is still the text; an edit made meanwhile
          // leaves the reference stale and is saved in its turn.
          change(conversationId, true, (latest) =>
            sourceTextFingerprint(latest.sourceText) === fingerprint
              ? { ...latest, sourceTextRef: stored }
              : { ...latest, sourceTextRef: { ...stored, fingerprint } },
          );
        })
        // The text stays in the browser; the next change tries again.
        .catch(() => undefined)
        .finally(() => saves.delete(conversationId));
      saves.set(conversationId, save);
    }, SOURCE_TEXT_STORE_DELAY_MS);
    return () => clearTimeout(timer);
    // `ref` is read as it is when the text changes; its identity changing
    // alone (an expiry noted) must not restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, sourceText, refId, ref?.fingerprint, detached, !state]);

  // Working on the conversation keeps the stored text alive.
  const updatedAt = state?.updatedAt;
  const openedAt = useRef(updatedAt);
  useEffect(() => {
    const current = readState(conversationId);
    const stored = current?.sourceTextRef;
    if (!current || !stored || stored.backend !== 'app') return;
    if (!hasCurrentSourceTextRef(current)) return;
    // Opening is not working on it.
    if (openedAt.current === updatedAt) return;
    const last = lastTouch.get(stored.id) ?? 0;
    if (Date.now() - last < RUN_KEEP_ALIVE_INTERVAL_MS) return;
    lastTouch.set(stored.id, Date.now());
    void touchSourceText(stored)
      .then((expiresAt) => noteExpiry(conversationId, stored.id, expiresAt))
      .catch((error: unknown) => {
        if (error instanceof RunMissingError) forgetRef(conversationId, stored);
      });
  }, [conversationId, updatedAt]);

  /** Keeps the stored text for another retention period, now. */
  const keep = useCallback(async () => {
    const stored = readState(conversationId)?.sourceTextRef;
    if (!stored) return;
    setKeeping(true);
    try {
      lastTouch.set(stored.id, Date.now());
      noteExpiry(conversationId, stored.id, await touchSourceText(stored));
    } catch (error) {
      if (error instanceof RunMissingError) forgetRef(conversationId, stored);
    } finally {
      setKeeping(false);
    }
  }, [conversationId]);

  /** Gives up on a text that cannot be fetched; the pane is then empty. */
  const forget = useCallback(() => {
    const stored = readState(conversationId)?.sourceTextRef;
    if (stored) forgetRef(conversationId, stored);
    setProblem(null);
  }, [conversationId]);

  return {
    /** The text is being fetched; the pane is empty until it arrives. */
    loading: detached && !problem,
    /** Why the text could not be fetched. */
    problem: detached ? problem : null,
    /** When app storage deletes the stored text, if it is there. */
    expiresAt: detached ? undefined : ref?.expiresAt,
    keeping,
    keep,
    forget,
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}

/**
 * Drops a reference. With the text in memory it is then kept in the
 * browser again (and saved anew if it is large); without it, it is gone.
 */
function forgetRef(conversationId: string, stored: StoredSourceTextRef): void {
  change(conversationId, true, (latest) => {
    if (latest.sourceTextRef?.id !== stored.id) return latest;
    const { sourceTextRef: _dropped, ...rest } = latest;
    return rest;
  });
}

export type StoredSourceText = ReturnType<typeof useStoredSourceText>;
