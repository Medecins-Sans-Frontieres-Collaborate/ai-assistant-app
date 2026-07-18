import { BackupApiError } from '@/lib/services/backup/backupApiClient';
import {
  type UploadedBlobInfo,
  buildNextManifest,
  computeLocalChanges,
  conversationUpdatedAt,
  mergeManifest,
} from '@/lib/services/backup/merge';
import type {
  BackupManifest,
  ManifestFetchResult,
  SyncDeps,
  SyncResult,
  SyncStatus,
} from '@/lib/services/backup/types';

import type { Conversation } from '@/types/chat';
import type { FolderInterface } from '@/types/folder';

/**
 * Store/UI-agnostic sync engine. Everything reaches it through SyncDeps.
 *
 * State machine per run:
 *   GET manifest →
 *     404 + never synced      → first push (create, epoch = local, no If-Match)
 *     404 + previously synced → 'remote-missing' (REMOTE_WIPED prompt upstream)
 *     manifest.disabled       → 'remote-missing'
 *     keyId ≠ local keyId     → 'key-out-of-date' (zero writes after detection)
 *     else                    → merge → upload blobs → CAS manifest
 *   CAS 409 VERSION_CONFLICT → refetch, re-merge, re-push (max 3 attempts)
 *   CAS 409 KEY_MISMATCH     → 'key-out-of-date', stop immediately
 * Local side effects (applyRemote, clearTombstones, persistSyncPoint) happen
 * only after the CAS succeeds — or, on a pull-only run, after the pulls.
 */

const MAX_CAS_ATTEMPTS = 3;

/** 16 random hex chars — immutable blob revision suffix. */
export function newRev(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function result(
  status: SyncStatus,
  partial: Partial<SyncResult> = {},
): SyncResult {
  return {
    status,
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflictRetries: 0,
    ...partial,
  };
}

function finish(
  deps: SyncDeps,
  status: SyncStatus,
  partial: Partial<SyncResult> = {},
): SyncResult {
  deps.onStatus?.(status);
  return result(status, partial);
}

async function runSyncOnce(deps: SyncDeps): Promise<SyncResult> {
  deps.onStatus?.('syncing');

  let fetched: ManifestFetchResult | null;
  try {
    fetched = await deps.api.getManifest();
  } catch (err) {
    return finish(deps, 'error', errorFields(err));
  }

  const syncPoint = deps.getSyncPoint();

  if (fetched === null && syncPoint.lastSyncedVersion !== null) {
    return finish(deps, 'remote-missing');
  }
  if (fetched !== null) {
    if (fetched.manifest.disabled) return finish(deps, 'remote-missing');
    if (fetched.manifest.keyId !== deps.crypto.keyId) {
      return finish(deps, 'key-out-of-date');
    }
  }

  let conflictRetries = 0;

  try {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const remote = fetched?.manifest ?? null;
      // Blobs carry the manifest's epoch in their AAD; the device's cached
      // epoch only seeds a brand-new manifest.
      const epoch = remote ? remote.epoch : deps.crypto.epoch;
      const local = deps.getLocalState();

      // "Remote unchanged since our last sync" requires the etag to match
      // too when we have one — version numbers restart from re-creates, so
      // equality alone could alias a different manifest generation.
      const point = deps.getSyncPoint();
      const remoteUnchanged =
        remote !== null &&
        remote.version === point.lastSyncedVersion &&
        (point.lastSyncedEtag === null ||
          fetched?.etag === point.lastSyncedEtag);

      const plan =
        remote !== null && !remoteUnchanged
          ? mergeManifest(local, remote)
          : computeLocalChanges(local, remote);

      // Pull first — the data does not depend on winning the CAS.
      const pulledConversations: Conversation[] = [];
      for (const id of plan.pullIds) {
        const entry = remote!.conversations[id];
        const bytes = await deps.api.getConversationBlob(id, entry.rev);
        pulledConversations.push(
          await deps.crypto.decryptConversation(id, epoch, bytes),
        );
      }
      let pulledFolders: FolderInterface[] | null = null;
      if (plan.foldersAction === 'pull' && remote?.folders) {
        const bytes = await deps.api.getFoldersBlob(remote.folders.rev);
        pulledFolders = await deps.crypto.decryptFolders(epoch, bytes);
      }

      const hasManifestWrites =
        remote === null ||
        plan.pushIds.length > 0 ||
        plan.pushTombstoneIds.length > 0 ||
        plan.foldersAction === 'push';

      if (!hasManifestWrites) {
        await deps.applyRemote({
          conversations: pulledConversations,
          folders: pulledFolders,
          deleteIds: plan.applyDeletes,
        });
        deps.persistSyncPoint({
          version: remote!.version,
          etag: fetched!.etag,
          epoch,
          syncedAt: new Date().toISOString(),
        });
        return finish(deps, 'ok', {
          pulled: pulledConversations.length,
          deleted: plan.applyDeletes.length,
          conflictRetries,
        });
      }

      // Upload immutable rev-named blobs BEFORE the manifest CAS — losers
      // only orphan revs, never corrupt the manifest.
      const localById = new Map(local.conversations.map((c) => [c.id, c]));
      const uploads: Record<string, UploadedBlobInfo> = {};
      for (const id of plan.pushIds) {
        const conversation = localById.get(id);
        if (!conversation) continue; // vanished mid-sync; next run will settle it
        const rev = newRev();
        const bytes = await deps.crypto.encryptConversation(
          conversation,
          epoch,
        );
        await deps.api.putConversationBlob(id, rev, bytes);
        uploads[id] = {
          rev,
          size: bytes.byteLength,
          updatedAt: conversationUpdatedAt(conversation),
        };
      }
      const pushIds = plan.pushIds.filter((id) => uploads[id]);

      let foldersUpload: { rev: string; updatedAt: string } | null = null;
      if (plan.foldersAction === 'push') {
        const rev = newRev();
        const bytes = await deps.crypto.encryptFolders(local.folders, epoch);
        await deps.api.putFoldersBlob(rev, bytes);
        foldersUpload = {
          rev,
          updatedAt: local.foldersUpdatedAt ?? new Date().toISOString(),
        };
      }

      const next: BackupManifest = buildNextManifest({
        base: remote,
        plan: { ...plan, pushIds },
        uploads,
        foldersUpload,
        tombstones: local.tombstones,
        keyId: deps.crypto.keyId,
        epoch,
        now: new Date().toISOString(),
      });

      try {
        const { etag } = await deps.api.putManifest(next, {
          ifMatchEtag: fetched?.etag ?? null,
        });
        await deps.applyRemote({
          conversations: pulledConversations,
          folders: pulledFolders,
          deleteIds: plan.applyDeletes,
        });
        // Every local tombstone is resolved by a successful sync: either
        // published to the manifest or beaten by a newer remote copy.
        const tombstoneIds = Object.keys(local.tombstones);
        if (tombstoneIds.length > 0) deps.clearTombstones(tombstoneIds);
        deps.persistSyncPoint({
          version: next.version,
          etag,
          epoch,
          syncedAt: new Date().toISOString(),
        });
        return finish(deps, 'ok', {
          pushed: pushIds.length,
          pulled: pulledConversations.length,
          deleted: plan.applyDeletes.length,
          conflictRetries,
        });
      } catch (err) {
        if (err instanceof BackupApiError) {
          if (err.code === 'BACKUP_KEY_MISMATCH') {
            // A rotated backup rejected us — stop writing immediately.
            return finish(deps, 'key-out-of-date', { conflictRetries });
          }
          if (err.code === 'BACKUP_VERSION_CONFLICT') {
            conflictRetries++;
            fetched = await deps.api.getManifest();
            if (fetched === null) {
              return finish(deps, 'remote-missing', { conflictRetries });
            }
            if (fetched.manifest.disabled) {
              return finish(deps, 'remote-missing', { conflictRetries });
            }
            if (fetched.manifest.keyId !== deps.crypto.keyId) {
              return finish(deps, 'key-out-of-date', { conflictRetries });
            }
            continue;
          }
        }
        throw err;
      }
    }

    return finish(deps, 'error', {
      conflictRetries,
      error: 'Backup version conflict persisted after retries',
      errorCode: 'BACKUP_VERSION_CONFLICT',
    });
  } catch (err) {
    return finish(deps, 'error', { conflictRetries, ...errorFields(err) });
  }
}

function errorFields(err: unknown): Partial<SyncResult> {
  if (err instanceof BackupApiError) {
    return { error: err.message, errorCode: err.code };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    errorCode: 'UNKNOWN',
  };
}

// Module-level single-flight: overlapping calls share the in-flight promise
// and queue exactly one rerun (with the latest deps) after it settles.
let inFlight: Promise<SyncResult> | null = null;
let rerunRequested = false;
let rerunDeps: SyncDeps | null = null;

export function runSync(deps: SyncDeps): Promise<SyncResult> {
  if (inFlight) {
    rerunRequested = true;
    rerunDeps = deps;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      let outcome = await runSyncOnce(deps);
      while (rerunRequested) {
        rerunRequested = false;
        const nextDeps = rerunDeps ?? deps;
        rerunDeps = null;
        outcome = await runSyncOnce(nextDeps);
      }
      return outcome;
    } finally {
      inFlight = null;
      rerunRequested = false;
      rerunDeps = null;
    }
  })();
  return inFlight;
}

/** True while a sync (or its queued rerun) is executing. */
export function isSyncRunning(): boolean {
  return inFlight !== null;
}

/**
 * Resolves once no sync (including queued reruns) is executing. Full-corpus
 * rewrites (rotation, reset, re-create) call this first so they never
 * interleave with a debounced incremental sync from the same device.
 */
export async function waitForSyncIdle(): Promise<void> {
  while (inFlight) {
    await inFlight.catch(() => undefined);
  }
}

/** Reset single-flight state — for tests and sign-out only. */
export function resetSyncEngineForTests(): void {
  inFlight = null;
  rerunRequested = false;
  rerunDeps = null;
}

/**
 * Restore flow: download and decrypt the entire remote backup and hand it to
 * applyRemote. Does not push; establishes the sync point so the next runSync
 * treats the manifest as already seen.
 */
export async function restoreFromRemote(deps: SyncDeps): Promise<SyncResult> {
  deps.onStatus?.('syncing');

  let fetched: ManifestFetchResult | null;
  try {
    fetched = await deps.api.getManifest();
  } catch (err) {
    return finish(deps, 'error', errorFields(err));
  }

  if (fetched === null || fetched.manifest.disabled) {
    return finish(deps, 'remote-missing');
  }
  const { manifest, etag } = fetched;
  if (manifest.keyId !== deps.crypto.keyId) {
    return finish(deps, 'key-out-of-date');
  }

  try {
    const conversations: Conversation[] = [];
    for (const [id, entry] of Object.entries(manifest.conversations)) {
      if (entry.deleted) continue;
      const bytes = await deps.api.getConversationBlob(id, entry.rev);
      conversations.push(
        await deps.crypto.decryptConversation(id, manifest.epoch, bytes),
      );
    }
    let folders: FolderInterface[] | null = null;
    if (manifest.folders) {
      const bytes = await deps.api.getFoldersBlob(manifest.folders.rev);
      folders = await deps.crypto.decryptFolders(manifest.epoch, bytes);
    }

    await deps.applyRemote({ conversations, folders, deleteIds: [] });
    deps.persistSyncPoint({
      version: manifest.version,
      etag,
      epoch: manifest.epoch,
      syncedAt: new Date().toISOString(),
    });
    return finish(deps, 'ok', { pulled: conversations.length });
  } catch (err) {
    return finish(deps, 'error', errorFields(err));
  }
}
