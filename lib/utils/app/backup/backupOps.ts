/**
 * UI-side backup orchestration helpers.
 *
 * The stores slice deliberately keeps `SyncDeps` construction inside
 * `useBackupSync` (its debounced trigger loop owns them); the UI flows that
 * run OUTSIDE that loop — enroll-progress, restore, enter-new-key, banner
 * reset/re-create — need their own deps and a full-corpus push primitive.
 * `buildBackupSyncDeps` mirrors the hook's wiring exactly (including the
 * remote folders-timestamp capture that prevents LWW ping-pong).
 */
import { createSyncCrypto } from '@/client/services/backup/syncCrypto';
import {
  BackupApiError,
  createBackupApiClient,
} from '@/lib/services/backup/backupApiClient';
import { conversationUpdatedAt, toMillis } from '@/lib/services/backup/merge';
import {
  newRev,
  runSync,
  waitForSyncIdle,
} from '@/lib/services/backup/syncEngine';
import type {
  BackupApi,
  BackupBackend,
  BackupManifest,
  BackupManifestEntry,
  RemoteApplyPayload,
  SyncDeps,
} from '@/lib/services/backup/types';

import type { BackupKeys } from '@/lib/utils/shared/backupCrypto/keyDerivation';

import { useBackupStore } from '@/client/stores/backupStore';
import { useConversationStore } from '@/client/stores/conversationStore';

/** The device's selected storage backend (app storage vs OneDrive). */
function selectedBackend(): BackupBackend {
  return useBackupStore.getState().storageBackend;
}

/**
 * Bridges stores + crypto + API client into the engine's SyncDeps.
 * `backend` overrides the device's selected backend (switch flow only —
 * the pre-migration pull must still run against the OLD backend).
 */
export function buildBackupSyncDeps(
  keys: BackupKeys,
  backend: BackupBackend = selectedBackend(),
): SyncDeps {
  const api = createBackupApiClient(undefined, backend);

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
      deletedAtById,
    }: RemoteApplyPayload) => {
      const store = useConversationStore.getState();
      if (conversations.length > 0 || deleteIds.length > 0) {
        const localById = new Map(store.conversations.map((c) => [c.id, c]));
        // Re-check LWW against the CURRENT store — an edit made while the
        // sync was downloading must survive the pre-download snapshot's
        // plan; the kept copy re-pushes on the next debounce.
        const deletes = new Set(
          deleteIds.filter((id) => {
            const local = localById.get(id);
            if (!local) return true;
            const deletedAt = deletedAtById?.[id];
            return (
              deletedAt === undefined ||
              toMillis(deletedAt) >= toMillis(conversationUpdatedAt(local))
            );
          }),
        );
        const pulledById = new Map(conversations.map((c) => [c.id, c]));
        // Replace in place, drop remote-won deletions, prepend remote-new.
        const merged = store.conversations
          .filter((c) => !deletes.has(c.id))
          .map((c) => {
            const pulled = pulledById.get(c.id);
            if (!pulled) return c;
            pulledById.delete(c.id);
            return toMillis(conversationUpdatedAt(c)) >
              toMillis(conversationUpdatedAt(pulled))
              ? c
              : pulled;
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

const MAX_CAS_ATTEMPTS = 3;

export interface PushFullBackupOptions {
  /**
   * Allow replacing a live manifest written under a DIFFERENT key (banner
   * "Reset backup" / key rotation). Without it, a live foreign-key manifest
   * aborts the push so an enroll flow can never silently clobber a backup.
   */
  overwriteLive?: boolean;
  /** Target backend; defaults to the device's selected one. */
  backend?: BackupBackend;
}

export interface PushFullBackupResult {
  keyId: string;
  epoch: number;
  version: number;
  etag: string;
  pushed: number;
}

/**
 * Encrypt the ENTIRE local corpus under `keys` and CAS a from-scratch
 * manifest with `epoch = remote.epoch + 1` (or 1 when none exists). Used by:
 * enroll over a disabled tombstone, key rotation, banner reset, and
 * re-creating a wiped backup. No base-entry carryover — entries encrypted
 * under a previous key/epoch would be undecryptable under the new manifest.
 *
 * Records the sync point and clears local tombstones on success; enrollment
 * status and keystore writes stay with the caller (ordering differs per flow).
 */
export async function pushFullBackup(
  keys: BackupKeys,
  options: PushFullBackupOptions = {},
): Promise<PushFullBackupResult> {
  // Never interleave a full-corpus rewrite with a debounced incremental sync
  // from this device — wait for the engine to go idle first.
  await waitForSyncIdle();
  const api = createBackupApiClient(
    undefined,
    options.backend ?? selectedBackend(),
  );
  let fetched = await api.getManifest();

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const remote = fetched?.manifest ?? null;
    if (
      remote !== null &&
      !remote.disabled &&
      remote.keyId !== keys.keyId &&
      !options.overwriteLive
    ) {
      throw new Error(
        'pushFullBackup: refusing to overwrite a live backup under a different key',
      );
    }

    const epoch = (remote?.epoch ?? 0) + 1;
    const crypto = createSyncCrypto(keys, epoch);
    const local = useConversationStore.getState();
    const now = new Date().toISOString();

    const conversations: Record<string, BackupManifestEntry> = {};
    for (const conversation of local.conversations) {
      const rev = newRev();
      const bytes = await crypto.encryptConversation(conversation, epoch);
      await api.putConversationBlob(conversation.id, rev, bytes);
      conversations[conversation.id] = {
        rev,
        updatedAt: conversationUpdatedAt(conversation),
        size: bytes.byteLength,
      };
    }
    // Preserve local tombstones so an outdated device holding a live copy
    // still loses last-writer-wins after the reset.
    for (const [id, deletedAt] of Object.entries(local.deletedConversations)) {
      if (conversations[id]) continue;
      conversations[id] = {
        rev: '',
        updatedAt: deletedAt,
        size: 0,
        deleted: true,
        deletedAt,
      };
    }

    let folders: BackupManifest['folders'] = null;
    if (local.foldersUpdatedAt !== null || local.folders.length > 0) {
      const rev = newRev();
      const bytes = await crypto.encryptFolders(local.folders, epoch);
      await api.putFoldersBlob(rev, bytes);
      folders = { rev, updatedAt: local.foldersUpdatedAt ?? now };
    }

    const manifest: BackupManifest = {
      schemaVersion: 1,
      keyId: keys.keyId,
      epoch,
      version: (remote?.version ?? 0) + 1,
      updatedAt: now,
      folders,
      conversations,
    };

    try {
      const { etag } = await api.putManifest(manifest, {
        ifMatchEtag: fetched?.etag ?? null,
      });
      const tombstoneIds = Object.keys(local.deletedConversations);
      if (tombstoneIds.length > 0) {
        useConversationStore.getState().clearSyncedTombstones(tombstoneIds);
      }
      useBackupStore.getState().recordSyncPoint({
        version: manifest.version,
        etag,
        epoch,
        syncedAt: new Date().toISOString(),
      });
      return {
        keyId: keys.keyId,
        epoch,
        version: manifest.version,
        etag,
        pushed: local.conversations.length,
      };
    } catch (err) {
      if (
        err instanceof BackupApiError &&
        err.code === 'BACKUP_VERSION_CONFLICT' &&
        attempt < MAX_CAS_ATTEMPTS - 1
      ) {
        // Another device won the CAS — refetch and rebuild against it.
        fetched = await api.getManifest();
        continue;
      }
      throw err;
    }
  }

  throw new Error('pushFullBackup: version conflict persisted after retries');
}

/**
 * Wipes the backup at `backend` and writes a disabled tombstone manifest so
 * other devices see "disabled", not "never existed". Shared by the settings
 * "Turn off & delete" flow and backend switching (old-location cleanup).
 */
export async function disableBackupAt(
  backend: BackupBackend,
  epochBase: number,
): Promise<void> {
  const api = createBackupApiClient(undefined, backend);
  await api.deleteBackup();
  const tombstone: BackupManifest = {
    schemaVersion: 1,
    keyId: null,
    epoch: epochBase + 1,
    // The wipe above removed the old manifest, so this write is a fresh
    // create — the server requires version 1 with no If-Match.
    version: 1,
    updatedAt: new Date().toISOString(),
    disabled: true,
    folders: null,
    conversations: {},
  };
  await api.putManifest(tombstone, { ifMatchEtag: null });
}

export interface SwitchBackendResult {
  /** Conversations pushed to the new backend. */
  pushed: number;
  /**
   * Old-location cleanup failed — an encrypted copy (or a live manifest
   * other devices could still sync against) may remain there. The switch
   * itself succeeded; callers surface this as a warning, not a failure.
   */
  cleanupFailed: boolean;
}

/**
 * Moves the encrypted backup between storage backends:
 *   1. pull-merge against the CURRENT backend so the migration pushes a
 *      complete corpus (a remote-only conversation from another device must
 *      not be dropped by the move);
 *   2. full-corpus push to the target (replacing whatever lives there —
 *      the settings confirm dialog owns that warning);
 *   3. flip the device's selected backend (the push already recorded the
 *      target sync point);
 *   4. best-effort wipe + disabled tombstone at the old location.
 *
 * Throws when the pre-sync or the target push fails — the device then stays
 * on its current backend with nothing lost.
 */
export async function switchBackupBackend(
  target: BackupBackend,
  keys: BackupKeys,
): Promise<SwitchBackendResult> {
  const store = useBackupStore.getState();
  const source = store.storageBackend;
  if (source === target) return { pushed: 0, cleanupFailed: false };

  const pre = await runSync(buildBackupSyncDeps(keys, source));
  if (pre.status !== 'ok' && pre.status !== 'remote-missing') {
    throw new Error(pre.error ?? `pre-switch sync failed (${pre.status})`);
  }
  // Capture the source epoch BEFORE the target push adopts the target's —
  // the old-location tombstone must outrank the old manifest, not the new.
  const sourceEpoch = useBackupStore.getState().localKeyEpoch;

  const pushed = await pushFullBackup(keys, {
    backend: target,
    overwriteLive: true,
  });
  useBackupStore.getState().setStorageBackend(target);

  let cleanupFailed = false;
  try {
    await disableBackupAt(source, sourceEpoch);
  } catch (error) {
    console.error('[backupOps] Old-backend cleanup failed:', error);
    cleanupFailed = true;
  }

  void useBackupStore.getState().refreshRemoteStatus();
  return { pushed: pushed.pushed, cleanupFailed };
}
