import { NextRequest } from 'next/server';

import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import { parseJsonResponse } from './helpers';

import { POST } from '@/app/api/transcription/cleanup/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: vi.fn(),
}));

vi.mock('@/lib/services/transcription/batchTranscriptionService', () => ({
  BatchTranscriptionService: vi.fn().mockImplementation(function (this: any) {
    this.isConfigured = () => false;
    this.deleteTranscription = vi.fn();
  }),
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

  it('returns 400 when neither jobId nor blobPath is provided', async () => {
    const response = await POST(makeRequest({}));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.details).toBe('MISSING_PARAMS');
  });
});
