/**
 * HKDF-SHA256 derivation for the chat-backup master key, with strict domain
 * separation (mirrors client/services/mcp/credentialVault.ts):
 *
 * - `'chat-backup-enc-v1'`  → non-extractable AES-GCM-256 CryptoKey, held in
 *   memory only. The raw master key is what gets persisted/encoded, never
 *   this derived key.
 * - `'chat-backup-fp-v1'`   → keyId: first 8 derived bytes as 16 hex chars.
 *   Safe to store server-side in plaintext — the master key is full-entropy,
 *   so the fingerprint reveals nothing brute-forceable, and the separate HKDF
 *   branch guarantees it leaks nothing about the encryption key.
 *
 * No salt is used: the master key is already uniform random, so domain
 * separation via `info` alone is sufficient (RFC 5869 §3.1).
 */

const ENC_INFO = 'chat-backup-enc-v1';
const FINGERPRINT_INFO = 'chat-backup-fp-v1';

const MASTER_KEY_BYTES = 32;
const KEY_ID_BYTES = 8;

export interface BackupKeys {
  /** Non-extractable AES-GCM-256 key for envelope encryption. */
  encKey: CryptoKey;
  /** 16-hex-char public fingerprint of the master key. */
  keyId: string;
}

async function importMasterKey(master: Uint8Array): Promise<CryptoKey> {
  if (master.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `master key must be ${MASTER_KEY_BYTES} bytes, got ${master.length}`,
    );
  }
  return crypto.subtle.importKey(
    'raw',
    // Copy: callers may hand us a view whose buffer type TS refuses to pass
    // to WebCrypto (e.g. values rehydrated from IndexedDB).
    new Uint8Array(master),
    'HKDF',
    false,
    ['deriveKey', 'deriveBits'],
  );
}

/** Public key fingerprint (HKDF fingerprint branch, first 8 bytes as hex). */
export async function computeKeyId(master: Uint8Array): Promise<string> {
  const hkdfKey = await importMasterKey(master);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(FINGERPRINT_INFO),
      },
      hkdfKey,
      KEY_ID_BYTES * 8,
    ),
  );
  return Array.from(bits, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** Derives the in-memory encryption key and public fingerprint together. */
export async function deriveBackupKeys(
  master: Uint8Array,
): Promise<BackupKeys> {
  const hkdfKey = await importMasterKey(master);
  const encKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(ENC_INFO),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
  return { encKey, keyId: await computeKeyId(master) };
}
