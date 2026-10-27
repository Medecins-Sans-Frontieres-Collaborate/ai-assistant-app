import { readSkill } from '@/lib/services/agentAccess/accessRulesStore';
import { streamToBuffer } from '@/lib/services/agentAccess/blobCas';
import { readPreparedSkillDocument } from '@/lib/services/skills/skillDocumentStore';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
function storageFor(value: unknown) {
  const download = vi.fn(async () => ({
    etag: 'v1',
    readableStreamBody: Readable.from([Buffer.from(JSON.stringify(value))]),
  }));
  return {
    download,
    storage: {
      getBlockBlobClient: () => ({ download }),
    } as unknown as BlobStorage,
  };
}
describe('skill blob defenses', () => {
  it('bounds actual streamed bytes instead of trusting declared length', async () => {
    const stream = Readable.from([Buffer.alloc(5), Buffer.alloc(6)]);
    await expect(streamToBuffer(stream, 10)).rejects.toThrow(/download limit/);
    expect(stream.destroyed).toBe(true);
    expect(
      await streamToBuffer(Readable.from([Buffer.alloc(10)]), 10),
    ).toHaveLength(10);
  });
  it('rejects a well-shaped blob masquerading as another skill id', async () => {
    const { storage } = storageFor({
      version: 1,
      id: 'other',
      name: 'Other',
      description: 'd',
      instructions: 'secret',
      activation: 'auto',
      documents: [],
      updatedAt: '',
    });
    await expect(readSkill(storage, 'requested')).rejects.toThrow(/identity/);
  });
  it('forwards cancellation and a timeout to the actual SDK download', async () => {
    const { storage, download } = storageFor({
      version: 1,
      id: 'test',
      name: 'Test',
      description: 'd',
      instructions: 'i',
      activation: 'auto',
      documents: [],
      updatedAt: '',
    });
    const abort = new AbortController();
    await readSkill(storage, 'test', abort.signal);
    const passed = (
      download.mock.calls as unknown as [
        number,
        undefined,
        { abortSignal: AbortSignal },
      ][]
    )[0][2].abortSignal;
    expect(passed.aborted).toBe(false);
    abort.abort();
    expect(passed.aborted).toBe(true);
  });
  it('rejects corrupt prepared text rather than trusting a JSON type assertion', async () => {
    const { storage } = storageFor({ text: 'Policy', tokens: -1, chunks: [] });
    await expect(
      readPreparedSkillDocument(
        storage,
        'test',
        '11111111-1111-1111-1111-111111111111',
      ),
    ).rejects.toThrow();
  });
});
