import { BlobJobSlots } from '@/lib/services/backgroundJobs/blobJobSlots';
import { BlobJobStore } from '@/lib/services/backgroundJobs/blobJobStore';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { describe, expect, it } from 'vitest';

/** The job store over an in-memory storage that answers like Azure's. */
function memoryStorage() {
  const blobs = new Map<string, Buffer>();
  const notFound = Object.assign(new Error('BlobNotFound'), {
    statusCode: 404,
    code: 'BlobNotFound',
  });
  const storage = {
    get: async (name: string) => {
      const blob = blobs.get(name);
      if (!blob) throw notFound;
      return blob;
    },
    // The content-addressed write, as BlobStorage.upload does it: a blob
    // of the same size is taken to be the same file and left alone.
    upload: async (name: string, data: Buffer) => {
      const stored = blobs.get(name);
      if (stored?.length === data.length) return name;
      blobs.delete(name);
      blobs.set(name, data);
      return name;
    },
    // A single Put Blob: an atomic replace.
    getBlockBlobClient: (name: string) => ({
      upload: async (data: Buffer) => {
        blobs.set(name, Buffer.from(data));
        return {};
      },
    }),
    deleteIfExists: async (name: string) => blobs.delete(name),
  } as unknown as BlobStorage;
  return { storage, blobs };
}

describe('state that changes in place', () => {
  // Each pair differs, once at the same length and once at another.
  const rewrites = [
    [{ heartbeatAt: 1763672049000 }, { heartbeatAt: 1763672052000 }],
    [{ status: 'running' }, { status: 'done' }],
  ];

  it.each(rewrites)(
    'keeps every write of a job (%o, then %o)',
    async (first, second) => {
      const { storage } = memoryStorage();
      const store = new BlobJobStore(storage, 'u1/deck-outlines/o1/');
      await store.putJob(first);
      await store.putJob(second);
      expect(await store.getJob()).toEqual(second);
    },
  );

  it.each(rewrites)(
    'keeps every write of the slots (%o, then %o)',
    async (first, second) => {
      const { storage } = memoryStorage();
      const slots = new BlobJobSlots(
        storage,
        'u1',
        'deck-outlines/active.json',
      );
      const record = (extra: object) => ({
        key: 'o1',
        label: 'Deck',
        heartbeatAt: 1763672049000,
        data: extra as Record<string, unknown>,
      });
      await slots.write(record(first));
      await slots.write(record(second));
      expect((await slots.read())[0].data).toEqual(second);
    },
  );
});

describe('BlobJobStore', () => {
  it('keeps state and a stop request under its folder', async () => {
    const { storage, blobs } = memoryStorage();
    const store = new BlobJobStore(storage, 'u1/brand-reviews/r1/');
    expect(await store.getJob()).toBeNull();
    expect(await store.stopRequested()).toBe(false);

    await store.putJob({ status: 'running', done: 2 });
    await store.requestStop();
    expect(await store.getJob()).toEqual({ status: 'running', done: 2 });
    expect(await store.stopRequested()).toBe(true);
    expect([...blobs.keys()].sort()).toEqual([
      'u1/brand-reviews/r1/job.json',
      'u1/brand-reviews/r1/stop.json',
    ]);

    await store.clearStop();
    expect(await store.stopRequested()).toBe(false);
    await store.remove();
    expect(blobs.size).toBe(0);
  });

  it('refuses a prefix that is not a folder', () => {
    const { storage } = memoryStorage();
    expect(() => new BlobJobStore(storage, 'u1/brand-reviews/r1')).toThrow(
      'must end in "/"',
    );
  });
});
