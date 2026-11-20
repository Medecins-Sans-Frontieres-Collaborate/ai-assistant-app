/**
 * Unconditional writes for files that change in place: job state, slots,
 * run records.
 *
 * `BlobStorage.upload()` is for content-addressed files. It skips a write
 * when a blob of the same byte length already exists, and deletes then
 * rewrites one of a different length. For a file that changes in place,
 * that drops every update which keeps the length (a heartbeat timestamp
 * moving on, one letter edited for another), and opens a window in which
 * readers find no file at all. A single Put Blob replaces the blob
 * atomically: readers see the old content or the new, never nothing.
 */
import { withAzureRetry } from '@/lib/utils/server/azure/retry';

import { BlobStorage } from './blob';

/**
 * Writes `data` to `blobName`, replacing whatever is there.
 *
 * @param storage - The storage client.
 * @param blobName - The blob's full name in the client's container.
 * @param data - The new content.
 * @param contentType - The content type to store with it.
 * @throws The storage error when the write fails after retries (5xx and
 *   network failures are retried; others surface at once).
 */
export async function overwriteBlob(
  storage: BlobStorage,
  blobName: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  const client = storage.getBlockBlobClient(blobName);
  await withAzureRetry(
    () =>
      client.upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType },
      }),
    { label: 'blob.overwrite' },
  );
}
