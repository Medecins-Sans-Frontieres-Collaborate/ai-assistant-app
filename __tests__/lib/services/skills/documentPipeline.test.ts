import {
  readSkill,
  writeSkill,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  readSkillOriginal,
  storeSkillFiles,
} from '@/lib/services/skills/skillDocumentStore';
import {
  retrySkillIndex,
  stepSkillIndex,
} from '@/lib/services/skills/skillIndexJob';
import {
  embedSkillTexts,
  ensureSkillIndex,
  uploadSkillChunks,
} from '@/lib/services/skills/skillSearch';
import type { Skill } from '@/lib/services/skills/types';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => ({ invalidate: vi.fn() }) },
}));
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/skills/skillSearch', () => ({
  skillSearchEndpoint: () => 'https://test-search.search.windows.net',
  ensureSkillIndex: vi.fn(),
  uploadSkillChunks: vi.fn(),
  embedSkillTexts: vi.fn(async (texts: string[]) => texts.map(() => [1])),
}));
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  loadDocument: vi.fn(async (file: File) => file.text()),
  countPdfPages: vi.fn(),
}));
vi.mock('@/lib/utils/server/tiktoken/tiktokenCache', () => ({
  countTokens: vi.fn(async (text: string) => text.length),
}));

/** Azure-like memory storage runs the real CAS/schema/store code. */
function memoryStorage(): BlobStorage {
  const records = new Map<string, { bytes: Buffer; etag: string }>();
  let version = 0;
  return {
    getBlockBlobClient: (path: string) => ({
      upload: async (
        value: string | Uint8Array,
        _size: number,
        options: {
          conditions?: { ifMatch?: string; ifNoneMatch?: string };
        } = {},
      ) => {
        const existing = records.get(path);
        if (
          (options.conditions?.ifMatch &&
            existing?.etag !== options.conditions.ifMatch) ||
          (options.conditions?.ifNoneMatch && existing)
        )
          throw { statusCode: 412 };
        const etag = `"v${++version}"`;
        records.set(path, { bytes: Buffer.from(value), etag });
        return { etag };
      },
      download: async () => {
        const record = records.get(path);
        if (!record) throw { statusCode: 404 };
        return {
          etag: record.etag,
          readableStreamBody: Readable.from([record.bytes]),
        };
      },
      deleteIfExists: async () => ({ succeeded: records.delete(path) }),
    }),
  } as unknown as BlobStorage;
}

describe('durable skill indexing', () => {
  it('refuses extraction whose normalized page text exceeds the chunker coverage cap', async () => {
    await seed('a\f'.repeat(300_000));
    await stepSkillIndex(storage, 'gdpr');
    const document = (await readSkill(storage, 'gdpr'))!.skill.documents[0];
    expect(document.indexStatus).toBe('failed');
    expect(document.error).toMatch(/chunk|split/i);
    expect(uploadSkillChunks).not.toHaveBeenCalled();
  });
  let storage: BlobStorage;
  beforeEach(() => {
    storage = memoryStorage();
    vi.clearAllMocks();
  });
  const seed = async (text: string) => {
    const documents = await storeSkillFiles(
      storage,
      'gdpr',
      [new File([text], 'references/policy.md')],
      'admin@msf.org',
    );
    const skill: Skill = {
      version: 1,
      id: 'gdpr',
      name: 'GDPR',
      description: 'Privacy',
      instructions: 'Cite policy',
      activation: 'auto',
      applyToAgents: false,
      documents,
      updatedAt: '',
    };
    await writeSkill(storage, skill, null);
    return documents[0];
  };
  it('stores originals and tiers exactly at the small-document token boundary', async () => {
    const doc = await seed('a'.repeat(2000));
    await stepSkillIndex(storage, 'gdpr');
    expect(
      (await readSkill(storage, 'gdpr'))!.skill.documents[0].indexStatus,
    ).toBe('inline');
    expect(ensureSkillIndex).not.toHaveBeenCalled();
    expect((await readSkillOriginal(storage, 'gdpr', doc.fileId))!.length).toBe(
      2000,
    );
  });
  it('indexes above the inline boundary and stamps the embedding deployment', async () => {
    await seed('a'.repeat(2001));
    await stepSkillIndex(storage, 'gdpr');
    const doc = (await readSkill(storage, 'gdpr'))!.skill.documents[0];
    expect(doc.indexStatus).toBe('indexed');
    expect(doc.embeddingDeployment).toBeTruthy();
    expect(uploadSkillChunks).toHaveBeenCalledOnce();
  });
  it('resumes batches from durable progress without extracting again', async () => {
    await seed('Text '.repeat(12_000));
    expect(await stepSkillIndex(storage, 'gdpr')).toEqual({
      pending: true,
      busy: false,
    });
    const after = (await readSkill(storage, 'gdpr'))!.skill.documents[0];
    expect(after.nextChunk).toBe(16);
    expect(after.indexStatus).toBe('pending');
    await stepSkillIndex(storage, 'gdpr');
    expect(
      (await readSkill(storage, 'gdpr'))!.skill.documents[0].indexStatus,
    ).toBe('indexed');
    expect(loadDocument).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadSkillChunks).mock.calls[1][0][0].chunk_id).toMatch(
      /_16$/,
    );
  });
  it('records failure and retries using the prepared payload', async () => {
    await seed('b'.repeat(2001));
    vi.mocked(uploadSkillChunks).mockRejectedValueOnce(
      new Error('Search temporarily unavailable'),
    );
    await stepSkillIndex(storage, 'gdpr');
    expect(
      (await readSkill(storage, 'gdpr'))!.skill.documents[0].indexStatus,
    ).toBe('failed');
    await retrySkillIndex(storage, 'gdpr');
    await stepSkillIndex(storage, 'gdpr');
    expect(
      (await readSkill(storage, 'gdpr'))!.skill.documents[0].indexStatus,
    ).toBe('indexed');
    expect(loadDocument).toHaveBeenCalledOnce();
  });
  it('does not claim a live lease, but recovers an expired one', async () => {
    await seed('small');
    let current = (await readSkill(storage, 'gdpr'))!;
    await writeSkill(
      storage,
      {
        ...current.skill,
        documents: current.skill.documents.map((doc) => ({
          ...doc,
          indexStatus: 'processing',
          claim: 'other-worker',
          leaseUntil: Date.now() + 100000,
        })),
      },
      current.etag,
    );
    expect(await stepSkillIndex(storage, 'gdpr')).toEqual({
      pending: false,
      busy: true,
    });
    expect(loadDocument).not.toHaveBeenCalled();
    current = (await readSkill(storage, 'gdpr'))!;
    await writeSkill(
      storage,
      {
        ...current.skill,
        documents: current.skill.documents.map((doc) => ({
          ...doc,
          leaseUntil: 0,
        })),
      },
      current.etag,
    );
    await stepSkillIndex(storage, 'gdpr');
    expect(
      (await readSkill(storage, 'gdpr'))!.skill.documents[0].indexStatus,
    ).toBe('inline');
  });
  it('cannot resurrect a document deleted during an index upload', async () => {
    await seed('c'.repeat(2001));
    vi.mocked(uploadSkillChunks).mockImplementationOnce(async () => {
      const current = (await readSkill(storage, 'gdpr'))!;
      await writeSkill(
        storage,
        { ...current.skill, documents: [] },
        current.etag,
      );
    });
    await stepSkillIndex(storage, 'gdpr');
    expect((await readSkill(storage, 'gdpr'))!.skill.documents).toEqual([]);
  });
  it('rejects a mislabeled PDF before invoking any parser', async () => {
    await expect(
      storeSkillFiles(
        storage,
        'gdpr',
        [new File(['not a PDF'], 'policy.pdf')],
        'admin',
      ),
    ).rejects.toThrow(/does not look/);
    expect(loadDocument).not.toHaveBeenCalled();
    expect(embedSkillTexts).not.toHaveBeenCalled();
  });
});
