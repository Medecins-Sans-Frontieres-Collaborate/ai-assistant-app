/**
 * Contract: `readGlobalAdmins` carries a client-side deadline. It hands
 * `downloadBlob` an `AbortSignal.timeout(readDeadlineMs)` so a stalled storage
 * connection rejects with an `AbortError` at the deadline instead of pending
 * forever (neither `withAzureRetry` nor the SDK client has a time budget of
 * its own). A read that responds normally is unaffected by the signal.
 */
import { readGlobalAdmins } from '@/lib/services/admin/globalAdminsStore';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: vi.fn(),
}));

interface DownloadOptions {
  abortSignal?: AbortSignal;
}

/**
 * A storage whose download never responds on its own; it only settles when
 * the abort signal it was handed fires (mirroring the SDK's behaviour).
 */
function stalledStorage() {
  const download = vi.fn(
    (_offset?: number, _count?: number, options?: DownloadOptions) =>
      new Promise<never>((_, reject) => {
        options?.abortSignal?.addEventListener('abort', () =>
          reject(
            Object.assign(new Error('The operation was aborted.'), {
              name: 'AbortError',
            }),
          ),
        );
      }),
  );
  const storage = {
    getBlockBlobClient: () => ({ download }),
  } as unknown as BlobStorage;
  return { storage, download };
}

function healthyStorage(body: string) {
  const download = vi.fn(
    async (_offset?: number, _count?: number, _options?: DownloadOptions) => ({
      readableStreamBody: Readable.from([Buffer.from(body, 'utf8')]),
      etag: '"e1"',
    }),
  );
  const storage = {
    getBlockBlobClient: () => ({ download }),
  } as unknown as BlobStorage;
  return { storage, download };
}

describe('admin/globalAdminsStore readGlobalAdmins', () => {
  // Well under the 5 s default so a read left unbounded FAILS fast here
  // rather than hanging the run.
  it(
    'rejects a stalled read at the deadline with an AbortError instead of pending forever',
    { timeout: 1_000 },
    async () => {
      const { storage, download } = stalledStorage();
      await expect(
        readGlobalAdmins(storage, { readDeadlineMs: 20 }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // One attempt only: an AbortError is neither a 5xx nor a network code,
      // so withAzureRetry must not re-enter the stalled read.
      expect(download).toHaveBeenCalledTimes(1);
      const options = download.mock.calls[0][2];
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options?.abortSignal?.aborted).toBe(true);
    },
  );

  it('hands a live (not yet aborted) deadline signal to a healthy read and parses the roster', async () => {
    const { storage, download } = healthyStorage(
      JSON.stringify({
        version: 1,
        admins: ['config@example.com'],
        updatedBy: 'env@example.com',
        updatedAt: '2026-09-04T00:00:00.000Z',
      }),
    );
    const result = await readGlobalAdmins(storage);
    expect(result?.roster.admins).toEqual(['config@example.com']);
    expect(result?.etag).toBe('"e1"');
    const options = download.mock.calls[0][2];
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options?.abortSignal?.aborted).toBe(false);
  });
});
