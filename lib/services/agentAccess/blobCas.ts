/**
 * Compare-and-swap blob primitives shared by every admin-authored config
 * store (agent access rules/config/prompt agents/connectors/guides/map
 * datasets, and usage limits).
 *
 * Mirrors the backup-manifest CAS pattern
 * (lib/services/backup/server/backupBlobStore.ts):
 *
 * ⚠ Writes deliberately bypass `AzureBlobStorage.upload()`: its same-byte-
 * length dedupe silently drops writes whose new content happens to match the
 * stored length — fatal for rule JSON that stays the same size across edits,
 * and fatal for usage counters, where `{"count":41}` → `{"count":42}` is
 * exactly that case. We use `getBlockBlobClient().upload` with ETag
 * conditions instead (`ifMatch` for updates, `ifNoneMatch: '*'` for creates).
 * `withAzureRetry` only retries 5xx/network errors, so a 412 precondition
 * failure surfaces immediately (no retry) and is translated here into
 * {@link AgentAccessConflictError} — routes map it to 409, and CAS loops
 * (usage counters) catch it to retry with a fresh read.
 */
import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';

/**
 * Thrown when an ETag precondition fails on a config/counter write — another
 * admin (or replica) won the compare-and-swap. Routes map this to 409.
 */
export class AgentAccessConflictError extends Error {
  constructor(message = 'Agent access blob was modified concurrently') {
    super(message);
    this.name = 'AgentAccessConflictError';
  }
}

/** Azure SDK errors carry the HTTP status as `statusCode` or `status`. */
export function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

export async function streamToBuffer(
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

export interface DownloadBlobOptions {
  /**
   * Client-side deadline for the whole download. The SDK aborts the request
   * AND its body stream when the signal fires, rejecting with an `AbortError`
   * (no status, no network code), which `withAzureRetry` therefore does not
   * retry. Without a signal a stalled connection keeps the promise pending
   * indefinitely — neither `withAzureRetry` nor `AzureBlobStorage` carries a
   * time budget — so reads on a request path should pass
   * `AbortSignal.timeout(…)`.
   */
  abortSignal?: AbortSignal;
}

/** Downloads a blob with its ETag. Returns null (not throws) on 404. */
export async function downloadBlob(
  storage: BlobStorage,
  blobPath: string,
  label = 'agentAccess.downloadBlob',
  options: DownloadBlobOptions = {},
): Promise<{ buffer: Buffer; etag: string } | null> {
  const client = storage.getBlockBlobClient(blobPath);
  try {
    return await withAzureRetry(
      async () => {
        const response = await client.download(0, undefined, {
          abortSignal: options.abortSignal,
        });
        if (!response.readableStreamBody) {
          throw new Error(`No readable stream for blob ${blobPath}`);
        }
        const buffer = await streamToBuffer(response.readableStreamBody);
        return { buffer, etag: response.etag ?? '' };
      },
      { label },
    );
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

/**
 * Conditional download for ETag-revalidated caches: `'unchanged'` when the
 * stored blob still carries `etag` (HTTP 304), the fresh bytes + ETag when it
 * moved, null on 404. One round trip with no body on the hot path.
 */
export async function downloadBlobIfChanged(
  storage: BlobStorage,
  blobPath: string,
  etag: string,
  label = 'agentAccess.downloadBlobIfChanged',
  options: DownloadBlobOptions = {},
): Promise<{ buffer: Buffer; etag: string } | 'unchanged' | null> {
  const client = storage.getBlockBlobClient(blobPath);
  try {
    return await withAzureRetry(
      async () => {
        const response = await client.download(0, undefined, {
          abortSignal: options.abortSignal,
          conditions: { ifNoneMatch: etag },
        });
        if (!response.readableStreamBody) {
          throw new Error(`No readable stream for blob ${blobPath}`);
        }
        const buffer = await streamToBuffer(response.readableStreamBody);
        return { buffer, etag: response.etag ?? '' };
      },
      { label },
    );
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 304) return 'unchanged';
    if (status === 404) return null;
    throw error;
  }
}

/**
 * Unconditional write marker for {@link uploadJson}: last writer wins. For
 * DERIVED records that are rebuilt wholesale by one writer (an index run's
 * manifest, a job record whose stored copy is unreadable) — never for
 * admin-edited config, which must stay compare-and-swap.
 */
export const OVERWRITE_BLOB: unique symbol = Symbol('overwrite-blob');

/**
 * `string` → update only if the ETag still matches; `null` → create only
 * (`If-None-Match: *`); {@link OVERWRITE_BLOB} → unconditional.
 */
export type UploadCondition = string | null | typeof OVERWRITE_BLOB;

/**
 * Conditional JSON write (see {@link UploadCondition}). A failed
 * precondition — 412 on an update, or Azure's 409 `BlobAlreadyExists` on a
 * create — surfaces as {@link AgentAccessConflictError}. Returns the new
 * ETag.
 */
export async function uploadJson(
  storage: BlobStorage,
  blobPath: string,
  payload: unknown,
  condition: UploadCondition,
  label: string,
  options: DownloadBlobOptions = {},
): Promise<string> {
  const client = storage.getBlockBlobClient(blobPath);
  const content = Buffer.from(JSON.stringify(payload), 'utf8');
  const conditions =
    condition === OVERWRITE_BLOB
      ? undefined
      : condition
        ? { ifMatch: condition }
        : { ifNoneMatch: '*' };
  try {
    const response = await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          ...(conditions ? { conditions } : {}),
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        }),
      { label },
    );
    return response.etag ?? '';
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 412 || (status === 409 && condition === null)) {
      throw new AgentAccessConflictError();
    }
    throw error;
  }
}
