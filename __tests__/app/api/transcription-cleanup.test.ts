import { NextRequest } from 'next/server';

import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import { parseJsonResponse } from './helpers';

import { POST } from '@/app/api/transcription/cleanup/route';
import { auth } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: vi.fn(),
}));

const mockBatchConfigured = vi.fn();
const mockDeleteTranscription = vi.fn();
const mockUserOwnsBatchJob = vi.fn();
vi.mock('@/lib/services/transcription/batchJobRegistry', () => ({
  userOwnsBatchJob: (...args: unknown[]) => mockUserOwnsBatchJob(...args),
  deleteBatchJobRecord: vi.fn(),
}));
vi.mock('@/lib/services/transcription/batchTranscriptionService', () => ({
  BatchTranscriptionService: vi.fn().mockImplementation(function (this: any) {
    this.isConfigured = () => mockBatchConfigured();
    this.deleteTranscription = (...args: unknown[]) =>
      mockDeleteTranscription(...args);
  }),
}));

const mockGetJobForUser = vi.fn();
const mockCleanupChunks = vi.fn();
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn().mockReturnValue({ fake: 'blob-storage' }),
}));
vi.mock('@/lib/services/transcription/chunkedJobStore', () => ({
  getJobForUser: (...args: unknown[]) => mockGetJobForUser(...args),
  JOB_ID_REGEX:
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}));
vi.mock('@/lib/utils/server/audio/audioSplitter', () => ({
  cleanupChunks: (...args: unknown[]) => mockCleanupChunks(...args),
}));

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_BLOB_STORAGE_NAME: 'test-storage',
    AZURE_BLOB_STORAGE_CONTAINER: 'messages',
    AZURE_BLOB_STORAGE_IMAGE_CONTAINER: 'messages',
  },
}));

describe('/api/transcription/cleanup', () => {
  const userId = 'owner-user-id';
  const otherUserId = 'other-user-id';
  const validJobId = '11111111-2222-3333-4444-555555555555';

  const mockSession = {
    user: { id: userId, email: 'owner@example.com', name: 'Owner' },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockBlobClient = {
    exists: vi.fn(),
    delete: vi.fn(),
  };

  const mockBlobStorage = {
    getBlockBlobClient: vi.fn(() => mockBlobClient),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AZURE_BLOB_STORAGE_NAME = 'test-storage';
    process.env.AZURE_BLOB_STORAGE_CONTAINER = 'messages';

    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(AzureBlobStorage).mockImplementation(function (this: any) {
      return mockBlobStorage as any;
    } as any);
    mockBlobClient.exists.mockResolvedValue(true);
    mockBlobClient.delete.mockResolvedValue(undefined);

    // Default: no known chunked job for this jobId. Tests that need chunk
    // cascade set this explicitly.
    mockGetJobForUser.mockReturnValue(undefined);
    mockCleanupChunks.mockResolvedValue(undefined);
    mockBatchConfigured.mockReturnValue(false);
    mockUserOwnsBatchJob.mockReturnValue(false);
    mockDeleteTranscription.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/transcription/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const response = await POST(
      makeRequest({ blobPath: `${userId}/transcripts/${validJobId}.txt` }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a blobPath belonging to another user', async () => {
    const response = await POST(
      makeRequest({
        blobPath: `${otherUserId}/transcripts/${validJobId}.txt`,
      }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('INVALID_BLOB_PATH');
    expect(mockBlobStorage.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it('rejects a blobPath that tries to traverse out of the user folder', async () => {
    const response = await POST(
      makeRequest({
        blobPath: `${userId}/transcripts/../other-user/secret.txt`,
      }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('INVALID_BLOB_PATH');
    expect(mockBlobStorage.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it('rejects a blobPath targeting a non-transcript folder', async () => {
    const response = await POST(
      makeRequest({
        blobPath: `${userId}/uploads/files/something.mp3`,
      }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('INVALID_BLOB_PATH');
    expect(mockBlobStorage.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it('rejects a blobPath with a non-UUID basename', async () => {
    const response = await POST(
      makeRequest({
        blobPath: `${userId}/transcripts/not-a-uuid.txt`,
      }),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('INVALID_BLOB_PATH');
  });

  it('rejects a non-UUID jobId', async () => {
    const response = await POST(makeRequest({ jobId: 'not-a-uuid' }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('INVALID_JOB_ID');
  });

  it('accepts and deletes a valid own-user blobPath', async () => {
    const blobPath = `${userId}/transcripts/${validJobId}.txt`;

    const response = await POST(makeRequest({ blobPath }));

    expect(response.status).toBe(200);
    expect(mockBlobStorage.getBlockBlobClient).toHaveBeenCalledWith(blobPath);
    expect(mockBlobClient.delete).toHaveBeenCalledTimes(1);
  });

  it.each(['job', 'blob'] as const)(
    'sanitizes %s deletion errors at the log boundary',
    async (target) => {
      const error = new Error('Azure error\r\nFORGED\u001b[31m');
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const blobPath = `${userId}/transcripts/${validJobId}.txt`;
      mockBatchConfigured.mockReturnValue(true);
      mockUserOwnsBatchJob.mockReturnValue(true);
      mockDeleteTranscription.mockRejectedValue(error);
      mockBlobClient.delete.mockRejectedValue(error);

      const response = await POST(
        makeRequest(target === 'job' ? { jobId: validJobId } : { blobPath }),
      );

      expect(response.status).toBe(200);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete'),
        'Azure error FORGED[31m',
      );
      expect(JSON.stringify(await parseJsonResponse(response))).toContain(
        'Azure error\\r\\nFORGED',
      );
    },
  );

  it('returns 400 when neither jobId nor blobPath is provided', async () => {
    const response = await POST(makeRequest({}));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('MISSING_PARAMS');
  });

  it('cascades chunk cleanup when the jobId matches a chunked job owned by the user', async () => {
    const chunkPaths = ['/tmp/chunked-transcription/jobX/a.mp3'];
    mockGetJobForUser.mockReturnValue({
      jobId: validJobId,
      userId,
      chunkPaths,
    });

    const response = await POST(makeRequest({ jobId: validJobId }));

    expect(response.status).toBe(200);
    expect(mockGetJobForUser).toHaveBeenCalledWith(
      expect.anything(),
      validJobId,
      userId,
    );
    expect(mockCleanupChunks).toHaveBeenCalledWith(chunkPaths);
  });

  it('does not invoke cleanupChunks when the job is not owned by the user', async () => {
    mockGetJobForUser.mockReturnValue(undefined);
    const response = await POST(makeRequest({ jobId: validJobId }));

    expect(response.status).toBe(200);
    expect(mockCleanupChunks).not.toHaveBeenCalled();
  });
});
