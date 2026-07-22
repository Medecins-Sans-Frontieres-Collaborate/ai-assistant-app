'use client';

/**
 * At-rest storage for the chat-backup master key: the raw 32 random bytes,
 * held in IndexedDB (db `chat-backup-keystore`).
 *
 * Design (mirrors client/services/mcp/credentialVault.ts):
 * - The raw key is stored UNWRAPPED, per the approved product decision that
 *   the recovery code must be re-viewable from Settings. What the key defends
 *   is the data at rest on the SERVER — backups are ciphertext the server can
 *   never read, because this key never leaves the device.
 * - The derived AES-GCM encryption key (deriveBackupKeys) is non-extractable
 *   and memory-only; only the master bytes are persisted.
 *
 * Honest threat-model note: local compromise and same-origin XSS are NOT
 * defended — code running in the origin (or with access to this browser
 * profile's disk) can read the key exactly like the app does. Clearing the
 * keystore ("turn off backup" / sign-out flows) removes the local copy; the
 * recovery code remains the only way back into the remote backup.
 */
import {
  type BackupKeys,
  deriveBackupKeys,
} from '@/lib/utils/shared/backupCrypto/keyDerivation';

/** Minimal async KV so tests can swap IndexedDB for memory. */
export interface KeystoreKvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB_NAME = 'chat-backup-keystore';
const STORE = 'kv';
const MASTER_KEY_RECORD = 'master-key-v1';
const MASTER_KEY_BYTES = 32;

function indexedDbKv(): KeystoreKvStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  return {
    get: (key) => withStore('readonly', (s) => s.get(key)),
    set: async (key, value) => {
      await withStore('readwrite', (s) => s.put(value, key));
    },
    delete: async (key) => {
      await withStore('readwrite', (s) => s.delete(key));
    },
  };
}

let kv: KeystoreKvStore | null = null;
function store(): KeystoreKvStore {
  if (!kv) kv = indexedDbKv();
  return kv;
}

/**
 * Single-flight memo over deriveBackupKeys: concurrent callers share one
 * load + derivation; a null result (no key saved) is never cached so a
 * later enrollment is picked up immediately.
 */
let keysPromise: Promise<BackupKeys | null> | null = null;

/** Persists the raw master key. Invalidates the derived-key memo. */
export async function saveMasterKey(key: Uint8Array): Promise<void> {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `master key must be ${MASTER_KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  // Copy: callers may reuse/zero their buffer after handing it to us.
  await store().set(MASTER_KEY_RECORD, new Uint8Array(key));
  keysPromise = null;
}

/** Raw master key, or null when this device holds none. */
export async function loadMasterKey(): Promise<Uint8Array | null> {
  const value = await store().get(MASTER_KEY_RECORD);
  if (value instanceof Uint8Array && value.length === MASTER_KEY_BYTES) {
    // Copy: IndexedDB values may be backed by a non-ArrayBuffer buffer type,
    // which TS (correctly) refuses to hand to WebCrypto.
    return new Uint8Array(value);
  }
  return null;
}

/** Removes the key from this device (disable / sign-out flows). */
export async function clearMasterKey(): Promise<void> {
  await store().delete(MASTER_KEY_RECORD);
  keysPromise = null;
}

/**
 * Derived {encKey, keyId} for the stored master key; null when no key is
 * saved. Single-flight: overlapping calls share one derivation, and a
 * successful non-null result is memoized until save/clear/reset.
 */
export function getBackupKeys(): Promise<BackupKeys | null> {
  if (!keysPromise) {
    // Assigned after creation; the comparisons below only run after an await,
    // by which point it holds this attempt's promise.
    let self: Promise<BackupKeys | null> | null = null;
    const attempt = (async (): Promise<BackupKeys | null> => {
      try {
        const master = await loadMasterKey();
        if (master === null) {
          // Do not cache absence — enrollment may save a key next tick.
          if (keysPromise === self) keysPromise = null;
          return null;
        }
        return await deriveBackupKeys(master);
      } catch (error) {
        // Allow a later retry instead of caching the failure.
        if (keysPromise === self) keysPromise = null;
        throw error;
      }
    })();
    self = attempt;
    keysPromise = attempt;
  }
  return keysPromise;
}

/** Drops the derived-key memo (e.g. after key rotation ceremonies). */
export function resetBackupKeyCache(): void {
  keysPromise = null;
}

/** Test hook. */
export function __setKeystoreKvForTests(
  replacement: KeystoreKvStore | null,
): void {
  kv = replacement;
  keysPromise = null;
}
