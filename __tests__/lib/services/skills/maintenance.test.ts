import { readSkill } from '@/lib/services/agentAccess/accessRulesStore';
import {
  queueSkillCleanup,
  startSkillMaintenance,
  stopSkillMaintenance,
  sweepSkillMaintenance,
} from '@/lib/services/skills/skillMaintenance';
import { deleteSkillChunks } from '@/lib/services/skills/skillSearch';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  readSkill: vi.fn(),
}));
vi.mock('@/lib/services/skills/skillSearch', () => ({
  deleteSkillChunks: vi.fn(),
}));
function memory() {
  const records = new Map<string, Buffer>();
  const storage = {
    listBlobs: async (prefix: string) =>
      [...records.keys()].filter((key) => key.startsWith(prefix)),
    getBlockBlobClient: (path: string) => ({
      upload: async (bytes: Buffer) => {
        records.set(path, Buffer.from(bytes));
        return { etag: 'v1' };
      },
      download: async () => {
        const bytes = records.get(path);
        if (!bytes) throw { statusCode: 404 };
        return { readableStreamBody: Readable.from([bytes]) };
      },
      deleteIfExists: async () => ({ succeeded: records.delete(path) }),
    }),
  } as unknown as BlobStorage;
  return { storage, records };
}
const fileId = '11111111-1111-1111-1111-111111111111';
const document = {
  fileId,
  filename: 'policy.md',
  sizeBytes: 1,
  indexStatus: 'indexed' as const,
  nextChunk: 2,
  chunkCount: 2,
  searchEndpoint: 'https://eu.search.windows.net',
  searchIndex: 'skills',
};
describe('skill maintenance', () => {
  it('continues bounded paged sweeps without requiring another admin page visit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const listBlobsPage = vi.fn(async () => ({ names: [] }));
    const { storage } = memory();
    storage.listBlobsPage = listBlobsPage;
    try {
      startSkillMaintenance(storage);
      await vi.waitFor(() => expect(listBlobsPage).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(listBlobsPage).toHaveBeenCalledTimes(4));
    } finally {
      stopSkillMaintenance();
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readSkill).mockResolvedValue(null);
    vi.mocked(deleteSkillChunks).mockResolvedValue();
  });
  it('prunes expired claims but keeps still-valid anti-replay records', async () => {
    const { storage, records } = memory();
    const expired = `system/agent-access/skill-continuations/${'a'.repeat(64)}.json`;
    const active = `system/agent-access/skill-continuations/${'b'.repeat(64)}.json`;
    records.set(expired, Buffer.from('{"expiresAt":100}'));
    records.set(active, Buffer.from('{"expiresAt":5000000}'));
    await sweepSkillMaintenance(storage, 4000000);
    expect(records.has(expired)).toBe(false);
    expect(records.has(active)).toBe(true);
  });
  it('retains failed cleanup for retry and targets the original index rather than a new default', async () => {
    const { storage, records } = memory();
    await queueSkillCleanup(storage, 'gdpr', [document], 0);
    vi.mocked(deleteSkillChunks).mockRejectedValueOnce(
      new Error('Temporary Search failure'),
    );
    await sweepSkillMaintenance(storage, 10000);
    expect(
      [...records.keys()].some((key) => key.includes('skill-cleanup/')),
    ).toBe(true);
    await sweepSkillMaintenance(storage, 10000);
    expect(
      [...records.keys()].some((key) => key.includes('skill-cleanup/')),
    ).toBe(false);
    expect(deleteSkillChunks).toHaveBeenCalledWith(
      fileId,
      2,
      { endpoint: 'https://eu.search.windows.net', index: 'skills' },
      expect.any(AbortSignal),
    );
  });
  it('never deletes an original still referenced by a live skill', async () => {
    const { storage, records } = memory();
    const original = `system/agent-access/skill-resources/gdpr/${fileId}/original`;
    records.set(original, Buffer.from('policy'));
    await queueSkillCleanup(storage, 'gdpr', [document], 0);
    vi.mocked(readSkill).mockResolvedValue({
      skill: { documents: [document] },
      etag: 'v1',
    } as never);
    await sweepSkillMaintenance(storage, 10000);
    expect(records.has(original)).toBe(true);
    expect(deleteSkillChunks).not.toHaveBeenCalled();
  });
  it('index migration cleanup keeps the live original and deletes only the obsolete index', async () => {
    const { storage, records } = memory();
    const original = `system/agent-access/skill-resources/gdpr/${fileId}/original`;
    records.set(original, Buffer.from('policy'));
    await queueSkillCleanup(storage, 'gdpr', [document], 0, true);
    vi.mocked(readSkill).mockResolvedValue({
      skill: {
        documents: [
          { ...document, searchEndpoint: 'https://new-eu.search.windows.net' },
        ],
      },
      etag: 'v1',
    } as never);
    await sweepSkillMaintenance(storage, 10000);
    expect(records.has(original)).toBe(true);
    expect(deleteSkillChunks).toHaveBeenCalled();
  });
  it('does not sweep a staging intent before its grace period', async () => {
    const { storage, records } = memory();
    await queueSkillCleanup(storage, 'gdpr', [document], 20000);
    await sweepSkillMaintenance(storage, 10000);
    expect(records.size).toBe(1);
    expect(readSkill).not.toHaveBeenCalled();
  });
});
