'use client';

import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useRef } from 'react';

import { getBackupKeys } from '@/client/services/backup/keystore';
import { createSyncCrypto } from '@/client/services/backup/syncCrypto';
import { createBackupApiClient } from '@/lib/services/backup/backupApiClient';
import { runSync } from '@/lib/services/backup/syncEngine';
import type {
  BackupApi,
  RemoteApplyPayload,
  SyncDeps,
  SyncResult,
  SyncStatus,
} from '@/lib/services/backup/types';

import type { BackupKeys } from '@/lib/utils/shared/backupCrypto/keyDerivation';

import { useBackupStore } from '@/client/stores/backupStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

/**
 * Wires the v1 backup sync triggers (see plan):
 * - on-load pull-merge-push, once session + rehydrate + flag + enrollment +
 *   key are all ready;
 * - 15s trailing-debounced auto-push on conversationStore data changes,
 *   deferred (5s re-check) while a chat response is streaming;
 * - manual syncNow (pull-first — runSync always GETs the manifest first).
 * Single-flight is the engine's job: overlapping runSync calls share the
 * in-flight promise and queue exactly one rerun.
 */

const AUTO_PUSH_DEBOUNCE_MS = 15_000;
const STREAMING_RETRY_MS = 5_000;

export interface UseBackupSyncResult {
  status: SyncStatus;
  lastBackupAt: string | null;
  /** True when the remote backup was rotated to a key this device lacks. */
  keyMismatch: boolean;
  /** Manual "Back up now". Resolves null when sync is not ready to run. */
  syncNow: () => Promise<SyncResult | null>;
}

/** Bridges stores + keystore + crypto + API client into the engine's deps. */
function buildSyncDeps(keys: BackupKeys): SyncDeps {
  const api = createBackupApiClient();

  // Capture the manifest's folders timestamp on every fetch: pulled folders
  // must be stamped with the REMOTE updatedAt — stamping "now" would win the
  // next whole-LWW comparison and ping-pong pushes between devices.
  let remoteFoldersUpdatedAt: string | null = null;
  const trackingApi: BackupApi = {
    ...api,
    getManifest: async () => {
      const fetched = await api.getManifest();
      remoteFoldersUpdatedAt = fetched?.manifest.folders?.updatedAt ?? null;
      return fetched;
    },
  };

  return {
    api: trackingApi,
    crypto: createSyncCrypto(keys, useBackupStore.getState().localKeyEpoch),
    getLocalState: () => {
      const state = useConversationStore.getState();
      return {
        conversations: state.conversations,
        folders: state.folders,
        foldersUpdatedAt: state.foldersUpdatedAt,
        tombstones: state.deletedConversations,
      };
    },
    getSyncPoint: () => {
      const state = useBackupStore.getState();
      return {
        lastSyncedVersion: state.lastSyncedVersion,
        lastSyncedEtag: state.lastSyncedEtag,
      };
    },
    applyRemote: ({
      conversations,
      folders,
      deleteIds,
    }: RemoteApplyPayload) => {
      const store = useConversationStore.getState();
      if (conversations.length > 0 || deleteIds.length > 0) {
        const deletes = new Set(deleteIds);
        const pulledById = new Map(conversations.map((c) => [c.id, c]));
        // Replace in place, drop remote-won deletions, prepend remote-new.
        const merged = store.conversations
          .filter((c) => !deletes.has(c.id))
          .map((c) => {
            const pulled = pulledById.get(c.id);
            if (pulled) pulledById.delete(c.id);
            return pulled ?? c;
          });
        store.setConversations([...pulledById.values(), ...merged]);
        if (
          store.selectedConversationId !== null &&
          deletes.has(store.selectedConversationId)
        ) {
          store.selectConversation(null);
        }
      }
      if (folders !== null) {
        store.setFolders(folders, remoteFoldersUpdatedAt ?? undefined);
      }
    },
    clearTombstones: (ids) =>
      useConversationStore.getState().clearSyncedTombstones(ids),
    persistSyncPoint: (point) =>
      useBackupStore.getState().recordSyncPoint(point),
    onStatus: (status) => useBackupStore.getState().setSyncStatus(status),
  };
}

export function useBackupSync(): UseBackupSyncResult {
  const { status: sessionStatus } = useSession();
  const flagEnabled = useBackupStore((state) => state.flagEnabled);
  const enrollmentStatus = useBackupStore((state) => state.enrollmentStatus);
  const syncStatus = useBackupStore((state) => state.syncStatus);
  const lastBackupAt = useBackupStore((state) => state.lastBackupAt);
  const isLoaded = useConversationStore((state) => state.isLoaded);

  const ready =
    sessionStatus === 'authenticated' &&
    isLoaded &&
    flagEnabled &&
    enrollmentStatus === 'enrolled';

  // Timers re-check the CURRENT gate when they fire, not the one captured
  // when they were scheduled.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const keysRef = useRef<BackupKeys | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sync = useCallback(async (): Promise<SyncResult | null> => {
    const keys = keysRef.current ?? (await getBackupKeys());
    if (!keys) return null; // enrolled but keystore empty — banner flow owns it
    keysRef.current = keys;
    const result = await runSync(buildSyncDeps(keys));
    if (result.status === 'error') {
      useBackupStore.getState().setSyncStatus('error', result.error);
    }
    return result;
  }, []);

  const fireScheduled = useCallback(() => {
    debounceRef.current = null;
    if (!readyRef.current) return;
    if (useChatStore.getState().isStreaming) {
      // Never race a streaming response for the conversations array —
      // re-check shortly instead of syncing a half-written message.
      debounceRef.current = setTimeout(fireScheduled, STREAMING_RETRY_MS);
      return;
    }
    void sync();
  }, [sync]);

  // On-load pull-merge-push, once per mount when everything is ready.
  const initialSyncStarted = useRef(false);
  useEffect(() => {
    if (!ready || initialSyncStarted.current) return;
    initialSyncStarted.current = true;
    void sync();
  }, [ready, sync]);

  // Trailing-debounced auto-push on conversation/folder/tombstone changes.
  useEffect(() => {
    if (!ready) return;
    const unsubscribe = useConversationStore.subscribe((state, prev) => {
      if (
        state.conversations === prev.conversations &&
        state.folders === prev.folders &&
        state.deletedConversations === prev.deletedConversations
      ) {
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fireScheduled, AUTO_PUSH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [ready, fireScheduled]);

  const syncNow = useCallback(async (): Promise<SyncResult | null> => {
    if (!readyRef.current) return null;
    return sync();
  }, [sync]);

  return {
    status: syncStatus,
    lastBackupAt,
    keyMismatch: syncStatus === 'key-out-of-date',
    syncNow,
  };
}
