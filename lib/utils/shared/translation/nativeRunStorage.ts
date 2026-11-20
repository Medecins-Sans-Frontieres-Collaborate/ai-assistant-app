/**
 * Where a formatting-preserving translation keeps its files, and how they
 * are named, addressed and protected. Shared by the server (which stores
 * them) and the browser (which reads them and keeps only references).
 *
 * CONVENTIONS (stated once; everything that touches a run's files cites these)
 *  - A RUN is one document's translation: its source PDF, the extractions,
 *    the translated PDF, the page images and the run record. All of them
 *    live in one folder named by the run's id, in ONE backend, chosen when
 *    the run starts and never changed.
 *  - BACKENDS: `onedrive` is the person's own OneDrive app folder: files
 *    stay until they delete them. `app` is the app's blob storage, which
 *    deletes a file {@link RUN_RETENTION_DAYS} days after it was last
 *    written. A run in `app` storage is kept alive by TOUCHING its files
 *    while it is worked on, and warns before it expires.
 *  - A FILE is named by its id, `<sha256>.<kind>` for what the server
 *    writes (so a file never changes once written) and
 *    {@link RUN_RECORD_ID} for the record the browser writes.
 *  - The browser holds a {@link NativeRunRef} and nothing else. Every file
 *    is fetched through {@link runFileUrl}.
 *  - ENCRYPTION: a run started while the person's backup key is on the
 *    device is encrypted at rest. The run's key is derived from that key
 *    and the run's id ({@link deriveRunKey}); the browser sends it with
 *    each request and the server uses it only for that request, to read
 *    what it must lay out and to encrypt what it writes. It is never
 *    stored. `keyId` on the ref names the backup key, so a device holding
 *    another key says so instead of failing to decrypt.
 */

/** Days after its last write that `app` storage deletes a file. */
export const RUN_RETENTION_DAYS = 5;
/** A run this close to expiry warns the person. */
export const RUN_EXPIRY_WARNING_DAYS = 2;
/** A file written more recently than this is not touched again. */
export const RUN_TOUCH_INTERVAL_HOURS = 12;
/** Quiet time after a change before the browser saves the record. */
export const RUN_SAVE_DELAY_MS = 1500;
/** While a run is worked on, the browser keeps it alive at most this often. */
export const RUN_KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

export const RUN_BACKENDS = ['app', 'onedrive'] as const;
export type NativeRunBackend = (typeof RUN_BACKENDS)[number];

/** The record of a run: its blocks, findings and pending changes. */
export const RUN_RECORD_ID = 'record.json';
/** Largest record the server accepts, in bytes. */
export const RUN_RECORD_MAX_BYTES = 8 * 1024 * 1024;
/** Most files a run may list as still in use. */
export const RUN_MAX_FILES = 2000;

/** Header carrying the run's key, base64, on requests of an encrypted run. */
export const RUN_KEY_HEADER = 'x-translation-run-key';
export const RUN_KEY_BYTES = 32;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVER_FILE_ID = /^[0-9a-f]{64}\.(pdf|json|png|pptx)$/;
const FILE_ROUTE = '/api/document-translation/native/file';

/** What the browser keeps of a run: where it is, never what is in it. */
export interface NativeRunRef {
  runId: string;
  backend: NativeRunBackend;
  /** Fingerprint of the backup key the run is encrypted under, if it is. */
  keyId?: string;
  /** The uploaded document the run was made from (see TranslationSourceDocument.url). */
  sourceUrl: string;
  /**
   * The run's own copy of that document. The upload expires like any other
   * file in app storage; this copy lives as long as the run does.
   */
  sourceId: string;
  /** ISO time `app` storage deletes the run unless touched; absent on OneDrive. */
  expiresAt?: string;
}

/** Whether a value is a run id (a lowercase UUID). */
export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

/** Whether a value names a backend. */
export function isRunBackend(value: unknown): value is NativeRunBackend {
  return (RUN_BACKENDS as readonly unknown[]).includes(value);
}

/** Whether a value is a file id a run can hold. */
export function isRunFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === RUN_RECORD_ID || SERVER_FILE_ID.test(value))
  );
}

/**
 * The path a run's file is fetched from.
 *
 * @param run - The run.
 * @param fileId - A file id accepted by {@link isRunFileId}.
 */
export function runFileUrl(
  run: Pick<NativeRunRef, 'runId' | 'backend'>,
  fileId: string,
): string {
  const query = new URLSearchParams({
    run: run.runId,
    storage: run.backend,
    id: fileId,
  });
  return `${FILE_ROUTE}?${query.toString()}`;
}

/**
 * Reads a path made by {@link runFileUrl} back.
 *
 * @returns The run and file it names, or null for any other path.
 */
export function parseRunFileUrl(
  url: string,
): { runId: string; backend: NativeRunBackend; fileId: string } | null {
  const [path, query = ''] = url.split('?');
  if (path !== FILE_ROUTE) return null;
  const params = new URLSearchParams(query);
  const runId = params.get('run');
  const backend = params.get('storage');
  const fileId = params.get('id');
  if (!isRunId(runId) || !isRunBackend(backend) || !isRunFileId(fileId)) {
    return null;
  }
  return { runId, backend, fileId };
}

/**
 * When `app` storage deletes a run whose oldest file was last written at
 * the given time.
 *
 * @param oldestWrite - Last write of the run's least recently written file.
 */
export function runExpiry(oldestWrite: Date): Date {
  return new Date(
    oldestWrite.getTime() + RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export type RunExpiryState = 'kept' | 'fine' | 'soon' | 'expired';

/**
 * How close a run is to being deleted.
 *  - `kept`: it does not expire (OneDrive, or no expiry known).
 *  - `soon`: {@link RUN_EXPIRY_WARNING_DAYS} days or less are left.
 *
 * @param expiresAt - The ref's `expiresAt`.
 * @param now - The current time, in epoch milliseconds.
 */
export function runExpiryState(
  expiresAt: string | undefined,
  now: number = Date.now(),
): RunExpiryState {
  if (!expiresAt) return 'kept';
  const left = Date.parse(expiresAt) - now;
  if (Number.isNaN(left)) return 'kept';
  if (left <= 0) return 'expired';
  return left <= RUN_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000
    ? 'soon'
    : 'fine';
}

/** Whole days left before a run expires, rounded up; 0 once expired. */
export function runDaysLeft(
  expiresAt: string,
  now: number = Date.now(),
): number {
  const left = Date.parse(expiresAt) - now;
  return left > 0 ? Math.ceil(left / (24 * 60 * 60 * 1000)) : 0;
}

// ── encryption ──────────────────────────────────────────────────────────────

/** First bytes of an encrypted file: format name and version. */
const MAGIC = new TextEncoder().encode('TRF1');
const IV_BYTES = 12;
const KEY_INFO = 'translation-run-v1|';

/** A file could not be decrypted: wrong key, or not what it claims to be. */
export class RunFileIntegrityError extends Error {
  constructor(fileId: string) {
    super(`The file ${fileId} could not be decrypted with this run's key`);
    this.name = 'RunFileIntegrityError';
  }
}

const bytesOf = (text: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

/** A copy backed by its own buffer, which WebCrypto requires. */
const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;

/**
 * Derives a run's key from the person's backup master key. One-way: the
 * run's key says nothing about the master key or another run's key.
 *
 * @param master - The backup master key.
 * @param runId - The run.
 * @returns {@link RUN_KEY_BYTES} bytes.
 */
export async function deriveRunKey(
  master: Uint8Array,
  runId: string,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    'raw',
    owned(master),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: bytesOf(KEY_INFO + runId),
    },
    base,
    RUN_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

async function aesKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== RUN_KEY_BYTES) {
    throw new Error(`A run key is ${RUN_KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey('raw', owned(key), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Ties a ciphertext to its run and file, so files cannot be swapped. */
const aad = (runId: string, fileId: string): Uint8Array<ArrayBuffer> =>
  bytesOf(`trf1|${runId}|${fileId}`);

/** Whether stored bytes are an encrypted run file. */
export function isEncryptedRunFile(bytes: Uint8Array): boolean {
  return (
    bytes.length > MAGIC.length + IV_BYTES &&
    MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

/**
 * Encrypts one file of a run (AES-256-GCM, a fresh nonce each time).
 *
 * @param key - The run's key.
 * @param runId - The run the file belongs to.
 * @param fileId - The file's id; decryption must name the same one.
 * @param plaintext - The file's bytes.
 * @returns The bytes to store.
 */
export async function encryptRunFile(
  key: Uint8Array,
  runId: string,
  fileId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(runId, fileId) },
      await aesKey(key),
      owned(plaintext),
    ),
  );
  const out = new Uint8Array(MAGIC.length + IV_BYTES + sealed.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(sealed, MAGIC.length + IV_BYTES);
  return out;
}

/**
 * Decrypts one file of a run.
 *
 * @param key - The run's key.
 * @param runId - The run the file belongs to.
 * @param fileId - The file's id, as it was encrypted under.
 * @param stored - The bytes as stored.
 * @returns The file's bytes.
 * @throws RunFileIntegrityError when the key, run or file does not match,
 *   or the bytes are not an encrypted run file.
 */
export async function decryptRunFile(
  key: Uint8Array,
  runId: string,
  fileId: string,
  stored: Uint8Array,
): Promise<Uint8Array> {
  if (!isEncryptedRunFile(stored)) throw new RunFileIntegrityError(fileId);
  const iv = stored.slice(MAGIC.length, MAGIC.length + IV_BYTES);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad(runId, fileId) },
        await aesKey(key),
        stored.slice(MAGIC.length + IV_BYTES),
      ),
    );
  } catch {
    throw new RunFileIntegrityError(fileId);
  }
}

/** Base64 of bytes, in the browser and in Node. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Bytes of a base64 string, or null when it is not base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
