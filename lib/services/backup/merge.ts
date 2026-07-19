import type {
  BackupManifest,
  LocalBackupState,
  MergePlan,
} from '@/lib/services/backup/types';

import type { Conversation } from '@/types/chat';

/**
 * Pure merge logic for the encrypted backup sync (v1 semantics):
 * per-conversation last-writer-wins on updatedAt (tie → remote), deletion
 * tombstones (delete wins when deletedAt >= updatedAt, else resurrect),
 * folders array whole-LWW. No message-level merge.
 */

/** Parse an ISO timestamp for comparison; missing/invalid sorts oldest. */
export function toMillis(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Keys that poison plain-object records (`record[id]` would surface
 * Object.prototype members or hit the __proto__ setter). The server rejects
 * these ids too, but the store is untrusted in this threat model.
 */
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/** Plain record → Map with hostile keys dropped; all lookups go through Maps. */
function toSafeMap<T>(record: Record<string, T>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [key, value] of Object.entries(record)) {
    if (!FORBIDDEN_IDS.has(key)) map.set(key, value);
  }
  return map;
}

/** Best-known local modification time of a conversation. */
export function conversationUpdatedAt(conversation: Conversation): string {
  return conversation.updatedAt ?? conversation.createdAt ?? '';
}

function emptyPlan(): MergePlan {
  return {
    pullIds: [],
    pushIds: [],
    applyDeletes: [],
    resurrectIds: [],
    pushTombstoneIds: [],
    foldersAction: 'none',
  };
}

function localConversationsById(
  local: LocalBackupState,
): Map<string, Conversation> {
  const byId = new Map<string, Conversation>();
  for (const conversation of local.conversations) {
    byId.set(conversation.id, conversation);
  }
  return byId;
}

/**
 * Compute local-only deltas against a manifest this device already knows
 * (remote unchanged since our last sync — its entries are our own last push),
 * or against no manifest at all (first push). Never pulls: any difference is,
 * by construction, a local edit.
 */
export function computeLocalChanges(
  local: LocalBackupState,
  remote: BackupManifest | null,
): MergePlan {
  const plan = emptyPlan();
  const byId = localConversationsById(local);

  if (remote === null) {
    plan.pushIds = [...byId.keys()];
    // Tombstones for a backup that never existed have nothing to delete.
    plan.foldersAction = local.foldersUpdatedAt !== null ? 'push' : 'none';
    return plan;
  }

  const remoteEntries = toSafeMap(remote.conversations);
  const tombstones = toSafeMap(local.tombstones);

  for (const [id, conversation] of byId) {
    const entry = remoteEntries.get(id);
    if (!entry) {
      plan.pushIds.push(id);
    } else if (entry.deleted) {
      // Our own manifest marks it deleted but it lives locally: local re-edit.
      plan.pushIds.push(id);
      plan.resurrectIds.push(id);
    } else if (conversationUpdatedAt(conversation) !== entry.updatedAt) {
      plan.pushIds.push(id);
    }
  }

  for (const id of tombstones.keys()) {
    if (byId.has(id)) continue; // live copy overrides a stale tombstone
    const entry = remoteEntries.get(id);
    if (entry && !entry.deleted) {
      plan.pushTombstoneIds.push(id);
    }
  }

  if (local.foldersUpdatedAt !== null) {
    if (
      remote.folders === null ||
      remote.folders.updatedAt !== local.foldersUpdatedAt
    ) {
      plan.foldersAction = 'push';
    }
  }

  return plan;
}

/**
 * Full bidirectional LWW merge, used when the remote manifest advanced past
 * our last sync point (another device wrote).
 */
export function mergeManifest(
  local: LocalBackupState,
  remote: BackupManifest,
): MergePlan {
  const plan = emptyPlan();
  const byId = localConversationsById(local);
  const remoteEntries = toSafeMap(remote.conversations);
  const tombstones = toSafeMap(local.tombstones);

  const ids = new Set<string>([
    ...byId.keys(),
    ...tombstones.keys(),
    ...remoteEntries.keys(),
  ]);

  for (const id of ids) {
    const localConversation = byId.get(id);
    // A live local copy overrides a stale local tombstone for the same id.
    const localTombstoneAt = localConversation ? undefined : tombstones.get(id);
    const entry = remoteEntries.get(id);

    if (!entry) {
      if (localConversation) {
        plan.pushIds.push(id);
      } else if (localTombstoneAt !== undefined) {
        // Remote never saw this conversation; record the deletion so an
        // outdated device holding a live copy still loses LWW later.
        plan.pushTombstoneIds.push(id);
      }
      continue;
    }

    if (!entry.deleted) {
      const remoteAt = toMillis(entry.updatedAt);
      if (localConversation) {
        const localAt = toMillis(conversationUpdatedAt(localConversation));
        if (localAt > remoteAt) {
          plan.pushIds.push(id);
        } else {
          plan.pullIds.push(id); // remote newer, or tie → remote wins
        }
      } else if (localTombstoneAt !== undefined) {
        if (toMillis(localTombstoneAt) >= remoteAt) {
          plan.pushTombstoneIds.push(id); // delete wins on tie
        } else {
          plan.pullIds.push(id); // remote edit outlives our deletion
        }
      } else {
        plan.pullIds.push(id);
      }
      continue;
    }

    // Remote tombstone.
    const remoteDeletedAt = toMillis(entry.deletedAt);
    if (localConversation) {
      if (
        remoteDeletedAt >= toMillis(conversationUpdatedAt(localConversation))
      ) {
        plan.applyDeletes.push(id); // delete wins on tie
      } else {
        plan.resurrectIds.push(id);
        plan.pushIds.push(id);
      }
    }
    // Local tombstone (or nothing) vs remote tombstone: already deleted remotely.
  }

  if (remote.folders === null) {
    plan.foldersAction = local.foldersUpdatedAt !== null ? 'push' : 'none';
  } else if (local.foldersUpdatedAt === null) {
    plan.foldersAction = 'pull';
  } else {
    const localAt = toMillis(local.foldersUpdatedAt);
    const remoteAt = toMillis(remote.folders.updatedAt);
    if (localAt > remoteAt) {
      plan.foldersAction = 'push';
    } else if (localAt < remoteAt) {
      plan.foldersAction = 'pull';
    } else {
      plan.foldersAction = 'none'; // identical timestamp ⇒ same whole-LWW blob
    }
  }

  return plan;
}

/** Metadata of a ciphertext blob uploaded during the current sync attempt. */
export interface UploadedBlobInfo {
  rev: string;
  size: number;
  updatedAt: string;
}

export interface BuildNextManifestArgs {
  /** The manifest the plan was computed against; null on first push. */
  base: BackupManifest | null;
  plan: MergePlan;
  /** Conversation id → blob uploaded for it (must cover every plan.pushIds). */
  uploads: Record<string, UploadedBlobInfo>;
  /** Set iff plan.foldersAction === 'push'. */
  foldersUpload: { rev: string; updatedAt: string } | null;
  /** Local tombstones (id → deletedAt) backing plan.pushTombstoneIds. */
  tombstones: Record<string, string>;
  keyId: string;
  epoch: number;
  now: string;
}

/**
 * Produce the next manifest to CAS: base entries carried over, pushed blobs
 * swapped in, winning tombstones recorded, version incremented by exactly 1
 * (the server rejects anything else).
 */
export function buildNextManifest(args: BuildNextManifestArgs): BackupManifest {
  const { base, plan, uploads, foldersUpload, tombstones, keyId, epoch, now } =
    args;

  const entries = toSafeMap(base?.conversations ?? {});
  const safeTombstones = toSafeMap(tombstones);

  for (const id of plan.pushIds) {
    const upload = uploads[id];
    if (!upload) {
      throw new Error(`buildNextManifest: missing upload for pushed id ${id}`);
    }
    entries.set(id, {
      rev: upload.rev,
      updatedAt: upload.updatedAt,
      size: upload.size,
    });
  }

  for (const id of plan.pushTombstoneIds) {
    const deletedAt = safeTombstones.get(id) ?? now;
    // A conversation deleted before its first push has no rev; the server
    // accepts an empty rev on tombstone entries (never dereferenced).
    entries.set(id, {
      rev: entries.get(id)?.rev ?? '',
      updatedAt: deletedAt,
      size: 0,
      deleted: true,
      deletedAt,
    });
  }

  return {
    schemaVersion: 1,
    keyId,
    epoch,
    version: (base?.version ?? 0) + 1,
    updatedAt: now,
    folders:
      plan.foldersAction === 'push' ? foldersUpload : (base?.folders ?? null),
    conversations: Object.fromEntries(entries),
  };
}
