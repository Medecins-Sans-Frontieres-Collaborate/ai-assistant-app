/**
 * Per-file preparation over an in-memory CAS blob fake: routing by kind
 * (vision / OCR / Whisper / chunked), refusals, derived-index bookkeeping,
 * and completing a pending chunked job.
 */
import { NextRequest } from 'next/server';

import type { M365Agent } from '@/lib/services/agentAccess/types';
import {
  readDerivedIndex,
  readDerivedText,
} from '@/lib/services/m365/agentDerivedTextStore';
import {
  PreparationError,
  completePendingPreparation,
  prepareAgentItem,
} from '@/lib/services/m365/agentPreparationService';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGraph = vi.hoisted(() => ({ graphJson: vi.fn() }));
const mockIndex = vi.hoisted(() => ({ downloadItemBytes: vi.fn() }));
const mockVision = vi.hoisted(() => ({ create: vi.fn() }));
const mockWhisper = vi.hoisted(() => ({ transcribe: vi.fn() }));
const mockChunked = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  startJob: vi.fn(),
}));
const mockJobStore = vi.hoisted(() => ({ getJobForUser: vi.fn() }));
const mockBudget = vi.hoisted(() => ({
  guardTranscriptionMinutes: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/auth', () => ({ auth: vi.fn(), getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return { ...actual, ...mockGraph };
});
vi.mock('@/lib/services/m365/agentIndexService', () => mockIndex);
vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({
      getOpenAIClient: () => ({ chat: { completions: mockVision } }),
    }),
  },
}));
vi.mock('@/lib/services/transcription/whisperTranscriptionService', () => ({
  WhisperTranscriptionService: class {
    transcribe = mockWhisper.transcribe;
  },
}));
vi.mock('@/lib/services/transcription/chunkedTranscriptionService', () => ({
  getChunkedTranscriptionService: () => mockChunked,
}));
vi.mock('@/lib/services/transcription/chunkedJobStore', () => mockJobStore);
vi.mock('@/lib/services/limits/transcriptionBudget', () => mockBudget);
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({}),
}));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: vi.fn(),
}));

function fakeStorage(): BlobStorage {
  const blobs = new Map<string, { body: string; etag: string }>();
  let counter = 0;
  const conflict = () => Object.assign(new Error('412'), { statusCode: 412 });
  return {
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
const session = {
  user: { id: 'u1', mail: 'admin@example.org' },
  expires: '',
} as never;
const agent = { id: 'm365-aaaaaaaaaaaa', sources: [] } as unknown as M365Agent;
const target = { driveId: 'd', itemId: 'it1' };

let storage: BlobStorage;

beforeEach(() => {
  vi.clearAllMocks();
  storage = fakeStorage();
  mockIndex.downloadItemBytes.mockResolvedValue({
    buffer: Buffer.from('bytes'),
    name: 'x',
  });
  mockVision.create.mockResolvedValue({
    choices: [{ message: { content: 'A chart of Q1 revenue: 1.2M, 1.4M' } }],
  });
  mockWhisper.transcribe.mockResolvedValue('hello world transcript');
});

describe('prepareAgentItem', () => {
  it('describes an image with the vision model and caches the text by eTag', async () => {
    mockGraph.graphJson.mockResolvedValue({
      id: 'it1',
      name: 'chart.png',
      size: 1000,
      eTag: '"v1"',
      file: { mimeType: 'image/png' },
    });
    const outcome = await prepareAgentItem(
      req,
      session,
      storage,
      agent,
      target,
    );
    expect(outcome).toMatchObject({
      status: 'prepared',
      kind: 'image',
      eTag: '"v1"',
    });
    const call = mockVision.create.mock.calls[0][0];
    expect(call.messages[0].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );

    const { index } = await readDerivedIndex(storage, agent.id);
    expect(index.items.it1).toMatchObject({
      eTag: '"v1"',
      kind: 'image',
      name: 'chart.png',
    });
    const text = await readDerivedText(storage, agent.id, 'it1');
    expect(text?.text).toContain('Q1 revenue');
  });

  it('refuses folders, unsupported types, malware and empty files before downloading', async () => {
    mockGraph.graphJson.mockResolvedValueOnce({
      id: 'f',
      name: 'Folder',
      folder: {},
      eTag: '"x"',
    });
    await expect(
      prepareAgentItem(req, session, storage, agent, target),
    ).rejects.toBeInstanceOf(PreparationError);

    mockGraph.graphJson.mockResolvedValueOnce({
      id: 'it1',
      name: 'doc.docx',
      size: 5,
      eTag: '"x"',
      file: {},
    });
    await expect(
      prepareAgentItem(req, session, storage, agent, target),
    ).rejects.toThrow(/cannot be prepared/);

    mockGraph.graphJson.mockResolvedValueOnce({
      id: 'it1',
      name: 'a.png',
      size: 5,
      eTag: '"x"',
      file: {},
      malware: {},
    });
    await expect(
      prepareAgentItem(req, session, storage, agent, target),
    ).rejects.toThrow(/malware/);

    mockGraph.graphJson.mockResolvedValueOnce({
      id: 'it1',
      name: 'a.png',
      size: 0,
      eTag: '"x"',
      file: {},
    });
    await expect(
      prepareAgentItem(req, session, storage, agent, target),
    ).rejects.toThrow(/empty/);
    expect(mockIndex.downloadItemBytes).not.toHaveBeenCalled();
  });

  it('transcribes small audio with Whisper under the admin’s budget', async () => {
    mockGraph.graphJson.mockResolvedValue({
      id: 'it1',
      name: 'call.mp3',
      size: 5 * 1024 * 1024,
      eTag: '"a1"',
      file: { mimeType: 'audio/mpeg' },
    });
    const outcome = await prepareAgentItem(
      req,
      session,
      storage,
      agent,
      target,
    );
    expect(outcome).toMatchObject({
      status: 'prepared',
      kind: 'audio',
      chars: 22,
    });
    expect(mockBudget.guardTranscriptionMinutes).toHaveBeenCalledTimes(1);
    expect(mockWhisper.transcribe).toHaveBeenCalledTimes(1);
    expect(mockVision.create).not.toHaveBeenCalled();
  });

  it('refuses when the transcription budget is exhausted', async () => {
    mockGraph.graphJson.mockResolvedValue({
      id: 'it1',
      name: 'call.mp3',
      size: 1024,
      eTag: '"a1"',
      file: { mimeType: 'audio/mpeg' },
    });
    mockBudget.guardTranscriptionMinutes.mockResolvedValueOnce({
      allowed: false,
      message: 'Daily limit reached',
    });
    await expect(
      prepareAgentItem(req, session, storage, agent, target),
    ).rejects.toMatchObject({ status: 429 });
    expect(mockWhisper.transcribe).not.toHaveBeenCalled();
  });

  it('hands large media to the chunked job and records it as pending', async () => {
    mockGraph.graphJson.mockResolvedValue({
      id: 'it1',
      name: 'townhall.mp4',
      size: 60 * 1024 * 1024,
      eTag: '"m1"',
      file: { mimeType: 'video/mp4' },
    });
    mockChunked.startJob.mockResolvedValue({
      jobId: 'job-uuid',
      totalChunks: 4,
    });
    const outcome = await prepareAgentItem(
      req,
      session,
      storage,
      agent,
      target,
    );
    expect(outcome).toMatchObject({
      status: 'pending',
      kind: 'video',
      jobId: 'job-uuid',
    });
    expect(mockWhisper.transcribe).not.toHaveBeenCalled();
    const { index } = await readDerivedIndex(storage, agent.id);
    expect(index.pending.it1).toMatchObject({
      jobId: 'job-uuid',
      eTag: '"m1"',
      startedBy: 'admin@example.org',
    });
  });
});

describe('completePendingPreparation', () => {
  beforeEach(async () => {
    mockGraph.graphJson.mockResolvedValue({
      id: 'it1',
      name: 'townhall.mp4',
      size: 60 * 1024 * 1024,
      eTag: '"m1"',
      file: { mimeType: 'video/mp4' },
    });
    mockChunked.startJob.mockResolvedValue({
      jobId: 'job-uuid',
      totalChunks: 4,
    });
    await prepareAgentItem(req, session, storage, agent, target);
  });

  it('reports running while the job is in flight', async () => {
    mockJobStore.getJobForUser.mockResolvedValue({ status: 'processing' });
    expect(
      await completePendingPreparation(session, storage, agent, 'it1'),
    ).toMatchObject({ status: 'running' });
  });

  it('stores the transcript when the job succeeded and clears pending', async () => {
    mockJobStore.getJobForUser.mockResolvedValue({
      status: 'succeeded',
      transcript: 'long transcript',
    });
    const outcome = await completePendingPreparation(
      session,
      storage,
      agent,
      'it1',
    );
    expect(outcome).toMatchObject({
      status: 'prepared',
      kind: 'video',
      eTag: '"m1"',
    });
    const { index } = await readDerivedIndex(storage, agent.id);
    expect(index.pending.it1).toBeUndefined();
    expect(index.items.it1).toMatchObject({ eTag: '"m1"', kind: 'video' });
    expect((await readDerivedText(storage, agent.id, 'it1'))?.text).toBe(
      'long transcript',
    );
  });

  it('fails cleanly when the job failed, and refuses another admin’s job', async () => {
    mockJobStore.getJobForUser.mockResolvedValueOnce({
      status: 'failed',
      error: 'ffmpeg died',
    });
    expect(
      await completePendingPreparation(session, storage, agent, 'it1'),
    ).toMatchObject({ status: 'failed', error: 'ffmpeg died' });
    expect(
      (await readDerivedIndex(storage, agent.id)).index.pending.it1,
    ).toBeUndefined();

    await prepareAgentItem(req, session, storage, agent, target);
    mockJobStore.getJobForUser.mockResolvedValueOnce(undefined);
    await expect(
      completePendingPreparation(session, storage, agent, 'it1'),
    ).rejects.toMatchObject({ status: 409 });
  });
});
