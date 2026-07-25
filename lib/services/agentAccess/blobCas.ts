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

/** Downloads a blob with its ETag. Returns null (not throws) on 404. */
export async function downloadBlob(
  storage: BlobStorage,
  blobPath: string,
  label = 'agentAccess.downloadBlob',
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
      { label },
    );
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

/**
 * Conditional JSON write. `ifMatchEtag` null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}.
 * Returns the new ETag.
 */
export async function uploadJson(
  storage: BlobStorage,
  blobPath: string,
  payload: unknown,
  ifMatchEtag: string | null,
  label: string,
): Promise<string> {
  const client = storage.getBlockBlobClient(blobPath);
  const content = Buffer.from(JSON.stringify(payload), 'utf8');
  try {
    const response = await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: ifMatchEtag
            ? { ifMatch: ifMatchEtag }
            : { ifNoneMatch: '*' },
        }),
      { label },
    );
    return response.etag ?? '';
  } catch (error) {
    if (statusCodeOf(error) === 412) {
      throw new AgentAccessConflictError();
    }
    throw error;
  }
}
