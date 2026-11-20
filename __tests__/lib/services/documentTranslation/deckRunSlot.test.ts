import { BlobDeckRunSlot } from '@/lib/services/documentTranslation/native/deckRunSlot';

import { describe, expect, it, vi } from 'vitest';

/**
 * The person's one deck slot, kept as the background job runner's slots in
 * the same blob it always used, so a slot written before reads the same.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));

const BLOB = 'u/translation-runs/active-deck-run.json';

function memoryStorage(initial?: object) {
  const blobs = new Map<string, Buffer>();
  if (initial) blobs.set(BLOB, Buffer.from(JSON.stringify(initial)));
  const notFound = Object.assign(new Error('BlobNotFound'), {
    statusCode: 404,
  });
  return {
    blobs,
    storage: {
      get: async (name: string) => {
        const blob = blobs.get(name);
        if (!blob) throw notFound;
        return blob;
      },
      // Written whole, as files that change in place are (overwriteBlob.ts).
      getBlockBlobClient: (name: string) => ({
        upload: async (data: Buffer) => blobs.set(name, Buffer.from(data)),
      }),
      deleteIfExists: async (name: string) => {
        blobs.delete(name);
      },
    } as never,
  };
}

const record = (runId: string) => ({
  runId,
  backend: 'onedrive' as const,
  sourceName: `${runId}.pptx`,
  heartbeatAt: 7,
});

describe('BlobDeckRunSlot', () => {
  it('reads a slot written in the single-record shape', async () => {
    const { storage } = memoryStorage(record('old'));
    await expect(new BlobDeckRunSlot(storage, 'u').read()).resolves.toEqual(
      record('old'),
    );
  });

  it('holds one run: a new one replaces the old, and release frees it', async () => {
    const { storage, blobs } = memoryStorage(record('old'));
    const slot = new BlobDeckRunSlot(storage, 'u');
    await slot.write(record('new'));
    await expect(slot.read()).resolves.toEqual(record('new'));
    expect(JSON.parse(blobs.get(BLOB)!.toString())).toHaveLength(1);
    // Releasing another run leaves it.
    await slot.release('old');
    await expect(slot.read()).resolves.toEqual(record('new'));
    await slot.release('new');
    await expect(slot.read()).resolves.toBeNull();
    expect(blobs.has(BLOB)).toBe(false);
  });
});
