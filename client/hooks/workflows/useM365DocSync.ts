'use client';

/**
 * Two-way sync engine for a document workflow bound to a OneDrive /
 * SharePoint file (docs/M365_THIRD_PASS_FEATURES_DESIGN.md §2).
 *
 * Push: debounced export + If-Match-guarded overwrite of the bound item.
 * Pull: escalating eTag poll while the workspace is open (client-driven —
 * delegated tokens only exist while the user is present). A remote change
 * with no local edits shows a reload banner; with local edits it becomes an
 * explicit conflict (keep mine / take theirs / keep both). Never a blind
 * overwrite in either direction.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  M365ClientError,
  M365DriveItemMeta,
  downloadDriveItem,
  getDriveItemMeta,
  saveToOneDrive,
  updateDriveItemContent,
} from '@/client/services/m365/m365Client';

import type {
  DocumentWorkflowState,
  M365DocumentBinding,
} from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';

export type M365BindingFormat = M365DocumentBinding['format'];

/** Idle debounce before an autoPush upload. */
const PUSH_DEBOUNCE_MS = 7000;
/** Pull-poll ladder: 15s doubling to a 60s cap; reset on local activity. */
const PULL_BASE_INTERVAL_MS = 15_000;
const PULL_MAX_INTERVAL_MS = 60_000;

/** The drive/item route adds the containing folder for "keep both" copies;
 * the shared client meta type (frozen) does not carry it. */
type DriveItemMetaWithParent = M365DriveItemMeta & {
  parentFolder?: { driveId: string; itemId: string };
};

export interface UseM365DocSyncOptions {
  conversationId: string;
  state: DocumentWorkflowState | undefined;
  /** Pushes hold while true (generation running / review edits pending). */
  blocked: boolean;
  /** Current docHtml → bytes in the binding's format. */
  exportForBinding: (format: M365BindingFormat) => Promise<Blob>;
  /**
   * Remote bytes → docHtml written into the workflow state. Resolves with
   * the exact html written, which becomes the clean-sync snapshot.
   */
  applyRemote: (
    content: string | ArrayBuffer,
    format: M365BindingFormat,
  ) => Promise<string>;
}

export interface M365DocSyncController {
  binding: M365DocumentBinding | undefined;
  pushing: boolean;
  /** Remote changed with no local edits — the workspace shows Reload. */
  remoteChanged: boolean;
  /** Remote and local diverged — the workspace freezes editing and asks. */
  conflict: boolean;
  resolving: boolean;
  reloadRemote: () => Promise<void>;
  resolveKeepMine: () => Promise<void>;
  resolveTakeTheirs: () => Promise<void>;
  resolveKeepBoth: () => Promise<void>;
  setAutoPush: (autoPush: boolean) => void;
  unbind: () => void;
}

export function useM365DocSync(
  options: UseM365DocSyncOptions,
): M365DocSyncController {
  const { conversationId, state, blocked } = options;
  const t = useTranslations('m365.docSync');

  const binding = state?.m365Binding;
  const docHtml = state?.docHtml ?? '';
  const autoPush = binding?.autoPush ?? false;
  const bindDriveId = binding?.driveId;
  const bindItemId = binding?.itemId;
  const bindETag = binding?.lastSyncedETag;

  const [pushing, setPushing] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [resolving, setResolving] = useState(false);

  // Latest-value refs: async work reads through these so in-flight
  // operations see current inputs without re-running effects.
  const docHtmlRef = useRef(docHtml);
  const bindingRef = useRef(binding);
  const exportRef = useRef(options.exportForBinding);
  const applyRef = useRef(options.applyRemote);
  useEffect(() => {
    docHtmlRef.current = docHtml;
    bindingRef.current = binding;
    exportRef.current = options.exportForBinding;
    applyRef.current = options.applyRemote;
  });

  /** docHtml at the last successful sync; divergence from it = local dirt. */
  const lastSyncedHtmlRef = useRef<string | null>(null);
  /** Bumped per operation and on unmount — stale completions must not write. */
  const seqRef = useRef(0);

  // (Re)binding seeds the clean snapshot from the docHtml present at bind
  // time — the bind flows (open / save-as / reload) write docHtml first.
  const boundKey =
    bindDriveId && bindItemId ? `${bindDriveId}:${bindItemId}` : null;
  useEffect(() => {
    lastSyncedHtmlRef.current = boundKey ? docHtmlRef.current : null;
    setRemoteChanged(false);
    setConflict(false);
  }, [boundKey]);

  useEffect(
    () => () => {
      seqRef.current += 1;
    },
    [],
  );

  const updateBinding = useCallback(
    (patch: Partial<M365DocumentBinding>) => {
      useConversationStore
        .getState()
        .updateWorkflowState(conversationId, (prev) => {
          const p = prev as DocumentWorkflowState;
          if (!p?.m365Binding) return p;
          return {
            ...p,
            m365Binding: { ...p.m365Binding, ...patch },
            updatedAt: new Date().toISOString(),
          };
        });
    },
    [conversationId],
  );

  const push = useCallback(async () => {
    const b = bindingRef.current;
    if (!b) return;
    const seq = ++seqRef.current;
    const snapshot = docHtmlRef.current;
    setPushing(true);
    try {
      const blob = await exportRef.current(b.format);
      const result = await updateDriveItemContent(blob, b.fileName, {
        driveId: b.driveId,
        itemId: b.itemId,
        ifMatch: b.lastSyncedETag,
      });
      if (seq !== seqRef.current) return;
      lastSyncedHtmlRef.current = snapshot;
      updateBinding({
        lastSyncedETag: result.eTag ?? b.lastSyncedETag,
        lastSyncedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (seq !== seqRef.current) return;
      if (error instanceof M365ClientError && error.code === 'M365_CONFLICT') {
        setConflict(true);
      } else {
        // Non-destructive: the document is untouched locally, and the
        // snapshot stays dirty so the next edit re-arms the debounce.
        toast.error(t('pushFailed'));
      }
    } finally {
      if (seq === seqRef.current) setPushing(false);
    }
  }, [t, updateBinding]);

  // PUSH: debounce after the last edit, then export + guarded overwrite.
  // Posture (design §2): write confirmation exists to keep MODEL output from
  // writing autonomously; these pushes deterministically mirror human edits
  // into a binding the human created, with autoPush as the opt-in — model
  // text only enters docHtml through explicit user actions first — so no
  // per-write confirmation.
  useEffect(() => {
    if (!autoPush || blocked || conflict || remoteChanged || resolving) return;
    if (docHtml === lastSyncedHtmlRef.current) return;
    const timer = window.setTimeout(() => {
      void push();
    }, PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    docHtml,
    autoPush,
    bindETag,
    blocked,
    conflict,
    remoteChanged,
    resolving,
    push,
  ]);

  // PULL: escalating eTag poll; paused while hidden or in conflict.
  useEffect(() => {
    if (!bindDriveId || !bindItemId || conflict) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const controller = new AbortController();

    const schedule = () => {
      timer = window.setTimeout(
        () => void tick(),
        Math.min(PULL_BASE_INTERVAL_MS * 2 ** attempt, PULL_MAX_INTERVAL_MS),
      );
    };

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      try {
        const meta = await getDriveItemMeta(bindDriveId, bindItemId, {
          signal: controller.signal,
        });
        if (cancelled) return;
        if (meta.eTag && meta.eTag !== bindETag) {
          if (docHtmlRef.current !== lastSyncedHtmlRef.current) {
            setConflict(true);
          } else {
            setRemoteChanged(true);
          }
        } else {
          setRemoteChanged(false);
        }
      } catch {
        // Transient poll failure — keep the ladder going.
      }
      if (cancelled) return;
      attempt += 1;
      schedule();
    };

    const onVisibility = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      attempt = 0;
      window.clearTimeout(timer);
      schedule();
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [bindDriveId, bindItemId, bindETag, conflict]);

  /** Downloads remote content into docHtml; returns whether it landed. */
  const performReload = useCallback(
    async (seq: number): Promise<boolean> => {
      const b = bindingRef.current;
      if (!b) return false;
      // Meta before content: if the remote moves between the two reads, the
      // stored eTag is stale and the next poll simply re-detects it.
      const meta = await getDriveItemMeta(b.driveId, b.itemId);
      const { blob } = await downloadDriveItem(b.driveId, b.itemId);
      const content =
        b.format === 'docx' ? await blob.arrayBuffer() : await blob.text();
      const html = await applyRef.current(content, b.format);
      if (seq !== seqRef.current) return false;
      lastSyncedHtmlRef.current = html;
      updateBinding({
        lastSyncedETag: meta.eTag ?? b.lastSyncedETag,
        lastSyncedAt: new Date().toISOString(),
        ...(meta.name && { fileName: meta.name }),
        ...(meta.webUrl && { webUrl: meta.webUrl }),
      });
      setRemoteChanged(false);
      setConflict(false);
      return true;
    },
    [updateBinding],
  );

  const reloadRemote = useCallback(async () => {
    const seq = ++seqRef.current;
    setResolving(true);
    try {
      await performReload(seq);
    } catch {
      if (seq === seqRef.current) toast.error(t('loadFailed'));
    } finally {
      if (seq === seqRef.current) setResolving(false);
    }
  }, [performReload, t]);

  const resolveKeepMine = useCallback(async () => {
    const b = bindingRef.current;
    if (!b) return;
    const seq = ++seqRef.current;
    const snapshot = docHtmlRef.current;
    setResolving(true);
    try {
      const blob = await exportRef.current(b.format);
      // No If-Match: overwriting the remote is the user's explicit decision.
      const result = await updateDriveItemContent(blob, b.fileName, {
        driveId: b.driveId,
        itemId: b.itemId,
      });
      if (seq !== seqRef.current) return;
      lastSyncedHtmlRef.current = snapshot;
      updateBinding({
        lastSyncedETag: result.eTag ?? b.lastSyncedETag,
        lastSyncedAt: new Date().toISOString(),
      });
      setConflict(false);
      setRemoteChanged(false);
      toast.success(t('conflictResolved'));
    } catch {
      if (seq === seqRef.current) toast.error(t('pushFailed'));
    } finally {
      if (seq === seqRef.current) setResolving(false);
    }
  }, [t, updateBinding]);

  const resolveTakeTheirs = useCallback(async () => {
    const seq = ++seqRef.current;
    setResolving(true);
    try {
      if (await performReload(seq)) toast.success(t('conflictResolved'));
    } catch {
      if (seq === seqRef.current) toast.error(t('loadFailed'));
    } finally {
      if (seq === seqRef.current) setResolving(false);
    }
  }, [performReload, t]);

  const resolveKeepBoth = useCallback(async () => {
    const b = bindingRef.current;
    if (!b) return;
    const seq = ++seqRef.current;
    setResolving(true);
    try {
      const blob = await exportRef.current(b.format);
      const meta = (await getDriveItemMeta(
        b.driveId,
        b.itemId,
      )) as DriveItemMetaWithParent;
      const dot = b.fileName.lastIndexOf('.');
      const copyName =
        dot > 0
          ? `${b.fileName.slice(0, dot)} (conflict copy)${b.fileName.slice(dot)}`
          : `${b.fileName} (conflict copy)`;
      // Next to the bound file when Graph reports the parent; otherwise the
      // default app folder. Create mode renames on collision — never clobbers.
      await saveToOneDrive(
        blob,
        copyName,
        meta.parentFolder
          ? {
              driveId: meta.parentFolder.driveId,
              parentId: meta.parentFolder.itemId,
            }
          : undefined,
      );
      if (seq !== seqRef.current) return;
      if (await performReload(seq)) toast.success(t('conflictResolved'));
    } catch {
      if (seq === seqRef.current) toast.error(t('loadFailed'));
    } finally {
      if (seq === seqRef.current) setResolving(false);
    }
  }, [performReload, t]);

  const setAutoPush = useCallback(
    (value: boolean) => updateBinding({ autoPush: value }),
    [updateBinding],
  );

  const unbind = useCallback(() => {
    useConversationStore
      .getState()
      .updateWorkflowState(conversationId, (prev) => {
        const p = prev as DocumentWorkflowState;
        if (!p?.m365Binding) return p;
        // Key removed, not set undefined — an unbound state must deep-equal
        // one that was never bound.
        const { m365Binding: _removed, ...rest } = p;
        return { ...rest, updatedAt: new Date().toISOString() };
      });
  }, [conversationId]);

  return {
    binding,
    pushing,
    remoteChanged,
    conflict,
    resolving,
    reloadRemote,
    resolveKeepMine,
    resolveTakeTheirs,
    resolveKeepBoth,
    setAutoPush,
    unbind,
  };
}
