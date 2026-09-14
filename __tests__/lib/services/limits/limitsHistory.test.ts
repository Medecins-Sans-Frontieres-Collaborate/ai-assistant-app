import { uploadJson } from '@/lib/services/agentAccess/blobCas';
import {
  HISTORY_RETAIN,
  pruneHistory,
  writeHistoryEntry,
} from '@/lib/services/limits/limitsStore';
import { LIMITS_HISTORY_PREFIX } from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, uploadJson: vi.fn(async () => '"e1"') };
});

function storageWith(count: number) {
  const blobs = Array.from({ length: count }, (_, i) => ({
    name: `${LIMITS_HISTORY_PREFIX}entry-${i}.json`,
    size: 10,
    // Older entries have smaller timestamps.
    lastModified: new Date(1_000_000 + i * 1000),
  }));
  const storage = {
    listBlobsDetailed: vi.fn(async () => blobs),
    deleteIfExists: vi.fn(async () => true),
    getBlockBlobClient: vi.fn(),
  } as unknown as BlobStorage & {
    listBlobsDetailed: ReturnType<typeof vi.fn>;
    deleteIfExists: ReturnType<typeof vi.fn>;
  };
  return { storage, blobs };
}

/**
 * Every policy write stores a full-document snapshot and nothing ever
 * pruned the prefix (efficiency review 2026-09-12, LOW). The trail is now
 * capped at HISTORY_RETAIN newest entries by lastModified, best-effort.
 */
describe('limits history retention', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes only the entries beyond HISTORY_RETAIN, oldest first', async () => {
    const { storage, blobs } = storageWith(HISTORY_RETAIN + 3);
    expect(await pruneHistory(storage)).toBe(3);
    const deleted = storage.deleteIfExists.mock.calls.map((c) => c[0]);
    expect(deleted.sort()).toEqual(
      [blobs[0].name, blobs[1].name, blobs[2].name].sort(),
    );
  });

  it('touches nothing at or under the cap', async () => {
    const { storage } = storageWith(HISTORY_RETAIN);
    expect(await pruneHistory(storage)).toBe(0);
    expect(storage.deleteIfExists).not.toHaveBeenCalled();
  });

  it('runs after a successful history write and never fails it', async () => {
    const { storage } = storageWith(HISTORY_RETAIN + 1);
    storage.deleteIfExists.mockRejectedValue(new Error('storage down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      writeHistoryEntry(storage, {
        version: 1,
        action: 'upsert',
        policy: null,
        updatedBy: 'admin@example.org',
        updatedAt: '2026-09-12T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
    expect(uploadJson).toHaveBeenCalledTimes(1);
    expect(storage.listBlobsDetailed).toHaveBeenCalledWith(
      LIMITS_HISTORY_PREFIX,
    );
  });
});
