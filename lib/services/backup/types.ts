/**
 * Shared contracts for the end-to-end encrypted chat backup feature.
 *
 * The server stores only opaque ciphertext blobs plus this manifest — the
 * single piece of plaintext it interprets. Conversation content never appears
 * here; only ids, revisions, timestamps, sizes, and the key fingerprint.
 */

export interface BackupManifestEntry {
  /** Revision suffix of the current immutable ciphertext blob for this conversation. */
  rev: string;
  /** Plaintext copy of the conversation's updatedAt, used for last-writer-wins merge. */
  updatedAt: string;
  /** Ciphertext size in bytes. */
  size: number;
  /** Tombstone — the conversation was deleted; no blob exists for this entry. */
  deleted?: true;
  deletedAt?: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  /**
   * Fingerprint of the master key (HKDF fingerprint branch, 16 hex chars).
   * Null only on a disabled tombstone manifest.
   */
  keyId: string | null;
  /** Increments on every key rotation, reset, or disable. Starts at 1. */
  epoch: number;
  /** App-level monotonic counter; must increment by exactly 1 per write. */
  version: number;
  /** ISO timestamp, client-stamped. */
  updatedAt: string;
  /** Set when backup was turned off; kept so other devices see "disabled", not "never existed". */
  disabled?: true;
  folders: { rev: string; updatedAt: string } | null;
  conversations: Record<string, BackupManifestEntry>;
}

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'ok'
  | 'key-out-of-date'
  | 'remote-missing'
  | 'error';

export type BackupApiErrorCode =
  | 'BACKUP_VERSION_CONFLICT'
  | 'BACKUP_KEY_MISMATCH'
  | 'BACKUP_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN';

export interface MergePlan {
  /** Conversations to download, decrypt, and insert/replace locally. */
  pullIds: string[];
  /** Conversations whose local copy wins and must be (re-)pushed. */
  pushIds: string[];
  /** Local conversations to delete because a remote tombstone wins. */
  applyDeletes: string[];
  /** Ids whose remote tombstone is overridden by a newer local edit (become live again). */
  resurrectIds: string[];
  /** Local tombstones that win and must be written to the manifest as deleted entries. */
  pushTombstoneIds: string[];
  foldersAction: 'push' | 'pull' | 'none';
}

export interface SyncResult {
  status: SyncStatus;
  pushed: number;
  pulled: number;
  deleted: number;
  conflictRetries: number;
  /** Set when status is 'error'. */
  error?: string;
  errorCode?: BackupApiErrorCode;
}

/**
 * Snapshot of everything on this device that participates in backup.
 * Supplied by the stores slice via SyncDeps.getLocalState.
 */
export interface LocalBackupState {
  conversations: import('@/types/chat').Conversation[];
  folders: import('@/types/folder').FolderInterface[];
  /**
   * ISO timestamp of the last local folder mutation. Null means "no local
   * folder state to back up" — the folders blob is then pull-only.
   */
  foldersUpdatedAt: string | null;
  /** Deletion tombstones: conversation id → ISO deletedAt. */
  tombstones: Record<string, string>;
}

/** Last successfully synced manifest coordinates (persisted in backupStore). */
export interface SyncPoint {
  lastSyncedVersion: number | null;
  lastSyncedEtag: string | null;
}

/** Written back through SyncDeps.persistSyncPoint after every successful sync. */
export interface PersistedSyncPoint {
  version: number;
  etag: string;
  epoch: number;
  syncedAt: string;
}

/** Remote data the engine asks the stores slice to apply locally. */
export interface RemoteApplyPayload {
  conversations: import('@/types/chat').Conversation[];
  /** Null when the remote folders blob did not win the merge. */
  folders: import('@/types/folder').FolderInterface[] | null;
  /** Conversations to delete locally because a remote tombstone won. */
  deleteIds: string[];
  /**
   * deletedAt per deleteIds entry so appliers can re-check LWW at apply
   * time — an edit made while the sync was downloading must survive a
   * tombstone computed from the pre-download snapshot.
   */
  deletedAtById?: Record<string, string>;
}

export interface ManifestFetchResult {
  manifest: BackupManifest;
  etag: string;
}

/**
 * Transport abstraction over the /api/backup routes. Implemented by
 * createBackupApiClient; every method throws BackupApiError on failure
 * (getManifest resolves null on 404 instead of throwing).
 */
export interface BackupApi {
  getManifest(): Promise<ManifestFetchResult | null>;
  putManifest(
    manifest: BackupManifest,
    opts: { ifMatchEtag: string | null },
  ): Promise<{ etag: string }>;
  putConversationBlob(
    id: string,
    rev: string,
    bytes: Uint8Array,
  ): Promise<void>;
  getConversationBlob(id: string, rev: string): Promise<Uint8Array>;
  deleteConversationBlob(id: string, rev: string): Promise<void>;
  putFoldersBlob(rev: string, bytes: Uint8Array): Promise<void>;
  getFoldersBlob(rev: string): Promise<Uint8Array>;
  deleteBackup(): Promise<void>;
}

/**
 * Crypto surface the engine needs. The epoch parameter is always the manifest
 * epoch in effect for the write/read (it feeds the AAD), which may differ from
 * the device's cached `epoch` when another device reset the backup.
 */
export interface SyncCrypto {
  /** HKDF fingerprint of this device's master key (16 hex chars). */
  keyId: string;
  /** This device's cached key epoch (used for first-push manifest creation). */
  epoch: number;
  encryptConversation(
    conversation: import('@/types/chat').Conversation,
    epoch: number,
  ): Promise<Uint8Array>;
  decryptConversation(
    conversationId: string,
    epoch: number,
    ciphertext: Uint8Array,
  ): Promise<import('@/types/chat').Conversation>;
  encryptFolders(
    folders: import('@/types/folder').FolderInterface[],
    epoch: number,
  ): Promise<Uint8Array>;
  decryptFolders(
    epoch: number,
    ciphertext: Uint8Array,
  ): Promise<import('@/types/folder').FolderInterface[]>;
}

/**
 * Everything the sync engine touches. The engine is UI/store-agnostic: the
 * stores slice wires these from backupStore/conversationStore without the
 * engine importing either.
 */
export interface SyncDeps {
  api: BackupApi;
  crypto: SyncCrypto;
  getLocalState(): LocalBackupState;
  getSyncPoint(): SyncPoint;
  /** Apply remote-winning data locally. Called at most once per successful sync. */
  applyRemote(payload: RemoteApplyPayload): void | Promise<void>;
  /** Clear resolved tombstones. Called only after a successful manifest CAS. */
  clearTombstones(ids: string[]): void;
  persistSyncPoint(point: PersistedSyncPoint): void;
  onStatus?(status: SyncStatus): void;
}
