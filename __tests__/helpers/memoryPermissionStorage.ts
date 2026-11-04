import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'node:stream';
import { vi } from 'vitest';

/** Blob SDK fixture with actual conditional-read/write behavior, shared by simulated replicas. */
export function memoryPermissionStorage() {
  const records = new Map<string, { body: string; etag: string }>();
  let revision = 0;
  const download = vi.fn(
    async (
      path: string,
      options?: { conditions?: { ifNoneMatch?: string } },
    ) => {
      const record = records.get(path);
      if (!record)
        throw Object.assign(new Error('Missing blob'), { statusCode: 404 });
      if (options?.conditions?.ifNoneMatch === record.etag)
        throw Object.assign(new Error('Unchanged'), { statusCode: 304 });
      return {
        readableStreamBody: Readable.from([record.body]),
        etag: record.etag,
      };
    },
  );
  const upload = vi.fn(
    async (
      path: string,
      content: Buffer,
      options?: { conditions?: { ifMatch?: string; ifNoneMatch?: string } },
    ) => {
      const record = records.get(path);
      if (options?.conditions?.ifNoneMatch === '*' && record)
        throw Object.assign(new Error('Already exists'), { statusCode: 409 });
      if (
        options?.conditions?.ifMatch &&
        record?.etag !== options.conditions.ifMatch
      )
        throw Object.assign(new Error('CAS conflict'), { statusCode: 412 });
      const etag = `"revision-${++revision}"`;
      records.set(path, { body: content.toString('utf8'), etag });
      return { etag };
    },
  );
  const storage = {
    getBlockBlobClient: (path: string) => ({
      download: (
        _offset: number,
        _count: number | undefined,
        options: Parameters<typeof download>[1],
      ) => download(path, options),
      upload: (
        content: Buffer,
        _length: number,
        options: Parameters<typeof upload>[2],
      ) => upload(path, content, options),
    }),
  } as unknown as BlobStorage;
  return { storage, records, download, upload };
}

/** Shared backing store for integration tests that inject the real permission-cache service. */
export const permissionStorage = memoryPermissionStorage();
