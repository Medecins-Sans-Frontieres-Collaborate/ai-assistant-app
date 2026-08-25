/**
 * Job orchestration over an in-memory CAS blob fake: start refuses a live
 * job, steps claim → process → record and the draining step finalizes
 * (reconcile, manifest, agent record), interrupted claims are released
 * on resume, cancel is terminal and sticky.
 */
import { NextRequest } from 'next/server';

import type {
  M365Agent,
  M365IndexJob,
  M365ManifestItem,
} from '@/lib/services/agentAccess/types';
import {
  IndexJobActiveError,
  cancelIndexJob,
  startIndexJob,
  stepIndexJob,
} from '@/lib/services/m365/agentIndexJobService';
import { readIndexJob } from '@/lib/services/m365/agentIndexJobStore';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIndex = vi.hoisted(() => ({
  DOCUMENT_INDEX_CONCURRENCY: 2,
  prepareIndexJob: vi.fn(),
  indexJobItem: vi.fn(),
  reconcileAgentChunks: vi.fn(async () => 0),
  mapWithConcurrency: async <T, R>(
    items: T[],
    _limit: number,
    fn: (item: T) => Promise<R>,
  ) => Promise.all(items.map(fn)),
}));
const mockStore = vi.hoisted(() => ({
  readM365Agent: vi.fn(),
  readM365AgentManifest: vi.fn(async () => null),
  writeM365Agent: vi.fn(async () => '"etag-2"'),
  writeM365AgentManifest: vi.fn(async () => undefined),
}));
const mockService = vi.hoisted(() => ({ invalidate: vi.fn() }));

vi.mock('@/auth', () => ({ auth: vi.fn(), getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/agentIndexService', () => mockIndex);
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return { ...actual, ...mockStore };
  },
);
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => mockService },
}));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: vi.fn(),
}));

/** Minimal CAS-faithful in-memory blob storage. */
function fakeStorage(): BlobStorage & {
  blobs: Map<string, { body: string; etag: string }>;
} {
  const blobs = new Map<string, { body: string; etag: string }>();
  let counter = 0;
  const conflict = () => Object.assign(new Error('412'), { statusCode: 412 });
  return {
    blobs,
    getBlockBlobClient(name: string) {
      return {
        async download() {
          const blob = blobs.get(name);
          if (!blob) throw Object.assign(new Error('404'), { statusCode: 404 });
          return {
            etag: blob.etag,
            readableStreamBody: Readable.from([Buffer.from(blob.body)]),
          };
        },
        async upload(
          content: Buffer,
          _len: number,
          options?: { conditions?: { ifMatch?: string; ifNoneMatch?: string } },
        ) {
          const current = blobs.get(name);
          const cond = options?.conditions ?? {};
          if (cond.ifNoneMatch === '*' && current) throw conflict();
          if (cond.ifMatch && current?.etag !== cond.ifMatch) throw conflict();
          const etag = `"e${++counter}"`;
          blobs.set(name, { body: content.toString('utf8'), etag });
          return { etag };
        },
        async delete() {
          blobs.delete(name);
        },
      } as never;
    },
    async deleteIfExists(name: string) {
      return blobs.delete(name);
    },
    async listBlobs(prefix: string) {
      return [...blobs.keys()].filter((k) => k.startsWith(prefix));
    },
  } as never;
}

const req = new NextRequest('http://localhost/api/x');
const agent: M365Agent = {
  version: 1,
  id: 'm365-aaaaaaaaaaaa',
  name: 'A',
  description: '',
  systemPrompt: '',
  chatModelId: null,
  embeddingModelId: '',
  ragConfig: { topK: 10 },
  sources: [
    {
      sourceId: 'src-1',
      driveId: 'd',
      itemId: 'root',
      kind: 'folder',
      title: 'Root',
      webUrl: '',
      status: 'pending',
      recursive: true,
      excludedItemIds: [],
    },
  ],
  createdBy: 'a',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedBy: 'a',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

function item(itemId: string): M365ManifestItem {
  return {
    itemId,
    driveId: 'd',
    name: `${itemId}.pdf`,
    path: '',
    parentItemId: 'root',
    size: 1,
    webUrl: '',
    tier: 'indexable',
    status: 'pending',
  };
}

function freshJob(items: string[]): M365IndexJob {
  const now = new Date().toISOString();
  return {
    version: 1,
    jobId: 'job-abcdefabcdef',
    agentId: agent.id,
    status: 'running',
    startedBy: 'admin@example.org',
    startedAt: now,
    updatedAt: now,
    embeddingDeployment: 'text-embedding',
    sources: [
      {
        sourceId: 'src-1',
        status: 'pending',
        truncated: false,
        folders: [],
        items: items.map(item),
      },
    ],
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  vi.clearAllMocks();
  storage = fakeStorage();
  mockStore.readM365Agent.mockResolvedValue({ m365Agent: agent, etag: '"a1"' });
  mockIndex.prepareIndexJob.mockImplementation(async () =>
    freshJob(['a', 'b', 'c']),
  );
  mockIndex.indexJobItem.mockImplementation(
    async (_req, _agentId, _dep, _sourceId, it: M365ManifestItem) =>
      it.itemId === 'b'
        ? { ...it, status: 'failed', indexedChunks: 0, error: 'boom' }
        : { ...it, status: 'indexed', indexedChunks: 2 },
  );
});

describe('startIndexJob', () => {
  it('writes the job, marks sources indexing, and refuses a second live start', async () => {
    const summary = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
    );
    expect(summary).toMatchObject({ status: 'running', total: 3, done: 0 });
    expect(mockStore.writeM365Agent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sources: [expect.objectContaining({ status: 'indexing' })],
      }),
      '"a1"',
    );
    await expect(
      startIndexJob(req, storage, agent, 'u1', 'admin@example.org'),
    ).rejects.toBeInstanceOf(IndexJobActiveError);
  });

  it('replaces a terminal or interrupted job', async () => {
    await startIndexJob(req, storage, agent, 'u1', 'admin@example.org');
    const stale = (await readIndexJob(storage, agent.id))!.job;
    stale.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    storage.blobs.set(`system/agent-access/m365-agent-jobs/${agent.id}.json`, {
      body: JSON.stringify(stale),
      etag: '"old"',
    });
    mockIndex.prepareIndexJob.mockImplementation(async () => ({
      ...freshJob(['z']),
      jobId: 'job-000000000000',
    }));
    const summary = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
    );
    expect(summary.jobId).toBe('job-000000000000');
  });
});

describe('startIndexJob refresh mode', () => {
  it('passes the manifest to prepareIndexJob for a refresh, and downgrades to full without one', async () => {
    const manifest = {
      version: 1,
      agentId: agent.id,
      updatedAt: 'x',
      sources: [],
    };
    mockStore.readM365AgentManifest.mockResolvedValueOnce(manifest as never);
    mockIndex.prepareIndexJob.mockImplementationOnce(async () => ({
      ...freshJob(['a']),
      mode: 'refresh',
      changes: { added: 1, modified: 0, removed: 0, unchanged: 3 },
    }));
    const summary = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
      'refresh',
    );
    expect(mockIndex.prepareIndexJob).toHaveBeenLastCalledWith(
      expect.anything(),
      agent,
      'u1',
      'admin@example.org',
      { mode: 'refresh', manifest },
    );
    expect(summary).toMatchObject({
      mode: 'refresh',
      changes: { added: 1, unchanged: 3 },
    });

    await cancelIndexJob(storage, agent.id, summary.jobId);
    mockStore.readM365AgentManifest.mockResolvedValueOnce(null);
    await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
      'refresh',
    );
    expect(mockIndex.prepareIndexJob).toHaveBeenLastCalledWith(
      expect.anything(),
      agent,
      'u1',
      'admin@example.org',
      { mode: 'full', manifest: null },
    );
  });
});

describe('stepIndexJob', () => {
  it('processes all items across steps and finalizes on the draining step', async () => {
    const { jobId } = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
    );
    // Budget 0: one claim batch per step (2 items, per the mocked concurrency).
    const first = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(first).toMatchObject({
      status: 'running',
      done: 2,
      indexed: 1,
      failed: 1,
    });
    expect(mockIndex.indexJobItem).toHaveBeenCalledTimes(2);

    const second = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(second).toMatchObject({ status: 'running', done: 3 });

    const third = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(third.status).toBe('succeeded');
    expect(mockIndex.reconcileAgentChunks).toHaveBeenCalledTimes(1);
    expect(mockStore.writeM365AgentManifest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: agent.id,
        sources: [
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ itemId: 'b', status: 'failed' }),
            ]),
          }),
        ],
      }),
    );
    // Agent record stamped: source indexed (partial failures are per item),
    // chunk total 4, embedding deployment recorded.
    const stamped = mockStore.writeM365Agent.mock.calls.at(-1)![1] as M365Agent;
    expect(stamped.embeddingModelId).toBe('text-embedding');
    expect(stamped.sources[0]).toMatchObject({
      status: 'indexed',
      indexedChunks: 4,
      counts: expect.objectContaining({ indexed: 2, failed: 1 }),
      error: 'boom',
    });
    // Sticky: stepping a finished job is a no-op.
    const again = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(again.status).toBe('succeeded');
    expect(mockIndex.indexJobItem).toHaveBeenCalledTimes(3);
  });

  it('releases a dead stepper’s claims when resuming a stale job', async () => {
    const { jobId } = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
    );
    const current = (await readIndexJob(storage, agent.id))!.job;
    current.sources[0].items[0].status = 'processing';
    current.updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    storage.blobs.set(`system/agent-access/m365-agent-jobs/${agent.id}.json`, {
      body: JSON.stringify(current),
      etag: '"stale"',
    });
    const summary = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(summary.done).toBe(2);
    expect(
      mockIndex.indexJobItem.mock.calls.map(
        (c) => (c[4] as M365ManifestItem).itemId,
      ),
    ).toEqual(['a', 'b']);
  });

  it('fails the job loudly when an item processor throws (session-level failure)', async () => {
    const { jobId } = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
    );
    mockIndex.indexJobItem.mockRejectedValue(new Error('token expired'));
    const summary = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(summary).toMatchObject({ status: 'failed', error: 'token expired' });
    const stored = (await readIndexJob(storage, agent.id))!.job;
    expect(stored.sources[0].items.every((i) => i.status === 'pending')).toBe(
      true,
    );
  });

  it('rejects a mismatched job id', async () => {
    await startIndexJob(req, storage, agent, 'u1', 'admin@example.org');
    await expect(
      stepIndexJob(req, storage, agent.id, 'job-ffffffffffff', 0),
    ).rejects.toThrow(/does not match/);
  });
});

describe('cancelIndexJob', () => {
  it('is terminal, releases claims, and blocks later steps', async () => {
    const { jobId } = await startIndexJob(
      req,
      storage,
      agent,
      'u1',
      'admin@example.org',
    );
    const cancelled = await cancelIndexJob(storage, agent.id, jobId);
    expect(cancelled?.status).toBe('cancelled');
    // Sources back to pending.
    const marked = mockStore.writeM365Agent.mock.calls.at(-1)![1] as M365Agent;
    expect(marked.sources[0].status).toBe('pending');
    expect(await cancelIndexJob(storage, agent.id, jobId)).toBeNull();
    const after = await stepIndexJob(req, storage, agent.id, jobId, 0);
    expect(after.status).toBe('cancelled');
    expect(mockIndex.indexJobItem).not.toHaveBeenCalled();
  });
});
