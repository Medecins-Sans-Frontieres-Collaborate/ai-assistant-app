/**
 * An in-memory stand-in for BlobStorage covering what the limits stats code
 * calls: block-blob download/upload (with If-Match / If-None-Match) and
 * prefix listing. Writes really overwrite, so a test sees what storage would.
 */
import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';

export interface MemoryBlobStorage {
  storage: BlobStorage;
  blobs: Map<string, { body: string; etag: string }>;
  /** Parsed JSON of a stored blob, or undefined. */
  json(name: string): unknown;
  put(name: string, value: unknown): void;
}

function statusError(statusCode: number): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

export function memoryBlobStorage(): MemoryBlobStorage {
  const blobs = new Map<string, { body: string; etag: string }>();
  let version = 0;
  const nextEtag = () => `"v${++version}"`;

  const client = (name: string) => ({
    async download() {
      const blob = blobs.get(name);
      if (!blob) throw statusError(404);
      return {
        etag: blob.etag,
        readableStreamBody: Readable.from([Buffer.from(blob.body, 'utf8')]),
      };
    },
    async upload(
      content: Buffer,
      _length: number,
      options: { conditions?: { ifMatch?: string; ifNoneMatch?: string } } = {},
    ) {
      const existing = blobs.get(name);
      const conditions = options.conditions;
      if (conditions?.ifNoneMatch === '*' && existing) throw statusError(409);
      if (conditions?.ifMatch && existing?.etag !== conditions.ifMatch) {
        throw statusError(412);
      }
      const etag = nextEtag();
      blobs.set(name, { body: content.toString('utf8'), etag });
      return { etag };
    },
  });

  const storage = {
    getBlockBlobClient: (name: string) => client(name),
    listBlobs: async (prefix: string) =>
      [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort(),
    deleteIfExists: async (name: string) => blobs.delete(name),
  } as unknown as BlobStorage;

  return {
    storage,
    blobs,
    json: (name) => {
      const blob = blobs.get(name);
      return blob ? JSON.parse(blob.body) : undefined;
    },
    put: (name, value) => {
      blobs.set(name, { body: JSON.stringify(value), etag: nextEtag() });
    },
  };
}
