'use client';

/**
 * Encrypted at-rest storage for MCP connector credentials (PATs, OAuth
 * access/refresh tokens, own-app client secrets).
 *
 * Design (privacy-stance compatible — the server stores nothing):
 * - Key = HKDF( server-derived per-user material [/api/mcp/vault-key],
 *               salt = random per-device value held in IndexedDB )
 *   → non-extractable AES-GCM CryptoKey, held in MEMORY for the session.
 * - Ciphertext lives in IndexedDB; localStorage carries NO MCP secrets
 *   (settingsStore partialize redacts them).
 * - Decryption therefore needs an authenticated session AND this device's
 *   salt: a copied localStorage dump has neither; a copied browser profile
 *   has the salt but not the session-bound key material.
 *
 * Honest threat-model note: same-origin XSS is NOT defended — code running
 * in the origin can use the vault exactly like the app does. The vault's job
 * is the at-rest artifact (disk copies, backups, storage dumps) and keeping
 * clear-text secrets out of web storage. If the server secret rotates or the
 * user changes, decryption fails and connectors degrade to "reconnect".
 */

export interface McpServerSecrets {
  authToken?: string;
  oauth?: {
    accessToken?: string;
    refreshToken?: string;
    clientSecret?: string;
  };
  oauthApp?: { clientSecret?: string };
}

/** Minimal async KV so tests can swap IndexedDB for memory. */
export interface VaultKvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const DB_NAME = 'mcp-credential-vault';
const STORE = 'kv';
const SALT_KEY = 'device-salt-v1';
const CREDENTIAL_PREFIX = 'server:';
const CIPHERTEXT_PREFIX = 'enc1:';

function indexedDbKv(): VaultKvStore {
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
    keys: async () =>
      (await withStore('readonly', (s) => s.getAllKeys())).map(String),
  };
}

let kv: VaultKvStore | null = null;
function store(): VaultKvStore {
  if (!kv) kv = indexedDbKv();
  return kv;
}

let sessionKeyPromise: Promise<CryptoKey> | null = null;

async function deriveSessionKey(): Promise<CryptoKey> {
  // 1. Server-derived per-user material (authenticated; never stored).
  const response = await fetch('/api/mcp/vault-key');
  if (!response.ok) {
    throw new Error(`vault key unavailable: ${response.status}`);
  }
  const json = await response.json();
  const material = Uint8Array.from(atob(json.data.keyMaterial), (c) =>
    c.charCodeAt(0),
  );

  // 2. Device-local random salt (IndexedDB; random, non-secret on its own).
  const storedSalt = (await store().get(SALT_KEY)) as Uint8Array | undefined;
  let salt: Uint8Array<ArrayBuffer>;
  if (storedSalt instanceof Uint8Array && storedSalt.length === 32) {
    // Copy: IndexedDB values may be backed by a non-ArrayBuffer buffer type,
    // which TS (correctly) refuses to hand to WebCrypto.
    salt = new Uint8Array(storedSalt);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await store().set(SALT_KEY, salt);
  }

  // 3. HKDF → non-extractable AES-GCM key, memory only.
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    material,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('mcp-credential-vault-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

/** Session vault key, fetched/derived once (single-flight). */
function getVaultKey(): Promise<CryptoKey> {
  if (!sessionKeyPromise) {
    sessionKeyPromise = deriveSessionKey().catch((error) => {
      // Allow a later retry (e.g. transient network) instead of caching failure.
      sessionKeyPromise = null;
      throw error;
    });
  }
  return sessionKeyPromise;
}

async function encryptString(plain: string): Promise<string> {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return CIPHERTEXT_PREFIX + btoa(String.fromCharCode(...packed));
}

async function decryptString(value: string): Promise<string | null> {
  if (!value.startsWith(CIPHERTEXT_PREFIX)) return null;
  try {
    const key = await getVaultKey();
    const packed = Uint8Array.from(
      atob(value.slice(CIPHERTEXT_PREFIX.length)),
      (c) => c.charCodeAt(0),
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, 12) },
      key,
      packed.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Rotated server secret / different user / corrupt record: the
    // credential is unrecoverable — callers treat it as absent.
    return null;
  }
}

/** Persists (or clears) one server's secret material, encrypted. */
export async function setServerSecrets(
  serverId: string,
  secrets: McpServerSecrets,
): Promise<void> {
  const hasAny =
    secrets.authToken ||
    secrets.oauth?.accessToken ||
    secrets.oauth?.refreshToken ||
    secrets.oauth?.clientSecret ||
    secrets.oauthApp?.clientSecret;
  if (!hasAny) {
    await store().delete(CREDENTIAL_PREFIX + serverId);
    return;
  }
  const ciphertext = await encryptString(JSON.stringify(secrets));
  await store().set(CREDENTIAL_PREFIX + serverId, ciphertext);
}

/** Reads one server's secrets; null when absent or undecryptable. */
export async function getServerSecrets(
  serverId: string,
): Promise<McpServerSecrets | null> {
  const value = await store().get(CREDENTIAL_PREFIX + serverId);
  if (typeof value !== 'string') return null;
  const plain = await decryptString(value);
  if (plain === null) return null;
  try {
    return JSON.parse(plain) as McpServerSecrets;
  } catch {
    return null;
  }
}

export async function deleteServerSecrets(serverId: string): Promise<void> {
  await store().delete(CREDENTIAL_PREFIX + serverId);
}

/** All server ids currently held in the vault. */
export async function listVaultedServerIds(): Promise<string[]> {
  const keys = await store().keys();
  return keys
    .filter((k) => k.startsWith(CREDENTIAL_PREFIX))
    .map((k) => k.slice(CREDENTIAL_PREFIX.length));
}

/** Test hooks. */
export function __setVaultKvForTests(replacement: VaultKvStore | null): void {
  kv = replacement;
  sessionKeyPromise = null;
}
