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
    upload: async (name: string, data: Buffer) => {
      blobs.set(name, data);
      return name;
    },
    deleteIfExists: async (name: string) => blobs.delete(name),
  } as unknown as BlobStorage;
  return { storage, blobs };
}

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
