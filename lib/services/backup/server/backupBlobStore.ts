import { BackupManifest } from '@/lib/services/backup/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';

/**
 * Server-side blob layout + accessors for the E2E-encrypted chat backup.
 *
 * Layout under the user's prefix (userId = Entra oid; never 'anonymous'):
 *   `${userId}/backup/manifest.json`        — the ONLY plaintext the server
 *                                             interprets; ETag compare-and-swap
 *   `${userId}/backup/conv/{id}.{rev}.bin`  — immutable ciphertext, rev-named
 *   `${userId}/backup/folders.{rev}.bin`    — immutable ciphertext, rev-named
 *
 * All ids/revs are validated against strict regexes BEFORE any path
 * interpolation — a conversation id is client-supplied and must never be able
 * to introduce `/`, `..`, or wildcard characters into a blob path.
 *
 * ⚠ Writes deliberately bypass `AzureBlobStorage.upload()`: its same-byte-
 * length dedupe silently drops writes whose new content happens to match the
 * stored length — fatal for a manifest whose JSON stays the same size across
 * versions. We use `getBlockBlobClient().upload` with ETag conditions instead.
 * `withAzureRetry` only retries 5xx/network errors, so a 412 precondition
 * failure surfaces immediately (no retry) and is translated here.
 */

/** Client-generated conversation ids: url-safe, bounded. */
export const CONV_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/** Client-generated blob revisions: exactly 16 lowercase hex chars. */
export const REV_REGEX = /^[0-9a-f]{16}$/;

/** Key fingerprints (HKDF fingerprint branch): exactly 16 lowercase hex chars. */
export const KEY_ID_REGEX = /^[0-9a-f]{16}$/;

/**
 * User ids are Entra oids (GUIDs) but test/dev sessions use freer strings.
 * No `/`, no whitespace; `.`/`..` rejected explicitly below.
 */
const USER_ID_REGEX = /^[A-Za-z0-9._@-]{1,128}$/;

/**
 * These match CONV_ID_REGEX but poison plain-object maps on the devices that
 * later merge the manifest (`conversations[id]` / `tombstones[id]` lookups).
 */
const FORBIDDEN_CONV_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function isValidConversationId(id: string): boolean {
  return CONV_ID_REGEX.test(id) && !FORBIDDEN_CONV_IDS.has(id);
}

export function isValidRev(rev: string): boolean {
  return REV_REGEX.test(rev);
}

function assertValidUserId(userId: string): void {
  if (
    !USER_ID_REGEX.test(userId) ||
    userId === 'anonymous' ||
    userId === '.' ||
    userId === '..'
  ) {
    throw new Error('Invalid backup user id');
  }
}

export function backupPrefix(userId: string): string {
  assertValidUserId(userId);
  return `${userId}/backup/`;
}

export function manifestPath(userId: string): string {
  return `${backupPrefix(userId)}manifest.json`;
}

export function conversationBlobPath(
  userId: string,
  conversationId: string,
  rev: string,
): string {
  if (!isValidConversationId(conversationId)) {
    throw new Error('Invalid backup conversation id');
  }
  if (!isValidRev(rev)) {
    throw new Error('Invalid backup blob revision');
  }
  return `${backupPrefix(userId)}conv/${conversationId}.${rev}.bin`;
}

export function foldersBlobPath(userId: string, rev: string): string {
  if (!isValidRev(rev)) {
    throw new Error('Invalid backup blob revision');
  }
  return `${backupPrefix(userId)}folders.${rev}.bin`;
}

/**
 * Thrown when an ETag precondition fails on a manifest write — another
 * device won the compare-and-swap. Routes map this to 409.
 */
export class BackupConflictError extends Error {
  constructor(message = 'Backup manifest was modified concurrently') {
    super(message);
    this.name = 'BackupConflictError';
  }
}

export interface ManifestReadResult {
  manifest: BackupManifest;
  /** Raw (quoted) Azure ETag — echoed to the client for If-Match CAS. */
  etag: string;
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

async function streamToBuffer(
  readableStream: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => resolve(Buffer.concat(chunks)));
    readableStream.on('error', reject);
  });
}

async function downloadBlob(
  storage: BlobStorage,
  blobPath: string,
): Promise<{ buffer: Buffer; etag: string } | null> {
  const client = storage.getBlockBlobClient(blobPath);
  try {
    return await withAzureRetry(
      async () => {
        const response = await client.download();
        if (!response.readableStreamBody) {
          throw new Error(`No readable stream for blob ${blobPath}`);
        }
        const buffer = await streamToBuffer(response.readableStreamBody);
        return { buffer, etag: response.etag ?? '' };
      },
      { label: 'backup.downloadBlob' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

/** Reads and parses the manifest. Returns null when no backup exists. */
export async function readManifest(
  storage: BlobStorage,
  userId: string,
): Promise<ManifestReadResult | null> {
  const result = await downloadBlob(storage, manifestPath(userId));
  if (result === null) return null;
  const manifest = JSON.parse(result.buffer.toString('utf8')) as BackupManifest;
  return { manifest, etag: result.etag };
}

/**
 * Compare-and-swap manifest write.
 *
 * - `ifMatchEtag` set → the write only succeeds against that exact blob
 *   version (`If-Match`).
 * - `ifMatchEtag` null → creation only (`If-None-Match: *`); fails if a
 *   manifest already exists.
 *
 * A 412 precondition failure (lost race / stale etag) throws
 * {@link BackupConflictError}. Returns the new ETag on success.
 */
export async function writeManifest(
  storage: BlobStorage,
  userId: string,
  manifest: BackupManifest,
  ifMatchEtag: string | null,
): Promise<string> {
  const client = storage.getBlockBlobClient(manifestPath(userId));
  const content = Buffer.from(JSON.stringify(manifest), 'utf8');
  try {
    const response = await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: ifMatchEtag
            ? { ifMatch: ifMatchEtag }
            : { ifNoneMatch: '*' },
        }),
      { label: 'backup.writeManifest' },
    );
    return response.etag ?? '';
  } catch (error) {
    if (statusCodeOf(error) === 412) {
      throw new BackupConflictError();
    }
    throw error;
  }
}

/**
 * Writes a rev-named ciphertext blob. Rev names are client-generated random
 * hex, so a blob that already exists at this path IS this content — a 412
 * from `If-None-Match: *` means an earlier attempt (or a retry) already
 * landed it, and is treated as idempotent success.
 */
export async function writeImmutableBlob(
  storage: BlobStorage,
  blobPath: string,
  content: Buffer,
): Promise<void> {
  const client = storage.getBlockBlobClient(blobPath);
  try {
    await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'backup.writeImmutableBlob' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 412) return;
    throw error;
  }
}

/** Reads a ciphertext blob. Returns null when it does not exist. */
export async function readBlob(
  storage: BlobStorage,
  blobPath: string,
): Promise<Buffer | null> {
  const result = await downloadBlob(storage, blobPath);
  return result === null ? null : result.buffer;
}

/**
 * Deletes every blob under the user's backup prefix (manifest + ciphertext).
 * Idempotent — returns the number of blobs actually deleted (0 when the
 * backup never existed or was already wiped).
 */
export async function deleteBackupPrefix(
  storage: BlobStorage,
  userId: string,
): Promise<number> {
  const names = await storage.listBlobs(backupPrefix(userId));
  let deleted = 0;
  for (const name of names) {
    if (await storage.deleteIfExists(name)) {
      deleted++;
    }
  }
  return deleted;
}
