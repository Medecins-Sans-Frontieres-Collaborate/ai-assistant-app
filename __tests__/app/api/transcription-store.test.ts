import { NextRequest } from 'next/server';

import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import { parseJsonResponse } from './helpers';

import { POST } from '@/app/api/transcription/store/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: vi.fn(),
}));

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_BLOB_STORAGE_NAME: 'test-storage',
    AZURE_BLOB_STORAGE_CONTAINER: 'messages',
    AZURE_BLOB_STORAGE_IMAGE_CONTAINER: 'messages',
  },
}));

const mockGetJob = vi.fn();
const mockGetJobForUser = vi.fn();
vi.mock('@/lib/services/transcription/chunkedJobStore', () => ({
  getJob: (...args: unknown[]) => mockGetJob(...args),
  getJobForUser: (...args: unknown[]) => mockGetJobForUser(...args),
  JOB_ID_REGEX:
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}));

describe('/api/transcription/store', () => {
  const userId = 'owner-user';
  const validJobId = '11111111-2222-3333-4444-555555555555';
  const session = {
    user: { id: userId, email: 'a@b.c', name: 'a' },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };

  const mockBlobStorage = {
    upload: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AZURE_BLOB_STORAGE_NAME = 'test-storage';
    process.env.AZURE_BLOB_STORAGE_CONTAINER = 'messages';
    vi.mocked(auth).mockResolvedValue(session as any);
    vi.mocked(AzureBlobStorage).mockImplementation(function (this: any) {
      return mockBlobStorage as any;
    } as any);
    mockGetJob.mockReturnValue(undefined);
    mockGetJobForUser.mockReturnValue(undefined);
  });

  const makeReq = (body: unknown) =>
    new NextRequest('http://localhost/api/transcription/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const res = await POST(
      makeReq({ jobId: validJobId, transcript: 'hi', filename: 'a.mp3' }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed jobId', async () => {
    const res = await POST(
      makeReq({ jobId: 'not-a-uuid', transcript: 'hi', filename: 'a.mp3' }),
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(400);
    expect(data.details).toBe('INVALID_JOB_ID');
  });

  it('rejects a transcript larger than the cap', async () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    const res = await POST(
      makeReq({ jobId: validJobId, transcript: big, filename: 'a.mp3' }),
    );
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(400);
    expect(data.details).toBe('TRANSCRIPT_TOO_LARGE');
  });

  it('returns 404 when the jobId matches a chunked job the user does not own', async () => {
    // Known chunked job exists, but not for this user.
    mockGetJob.mockReturnValue({ jobId: validJobId, userId: 'someone-else' });
    mockGetJobForUser.mockReturnValue(undefined);

    const res = await POST(
      makeReq({ jobId: validJobId, transcript: 'hi', filename: 'a.mp3' }),
    );
    expect(res.status).toBe(404);
  });

  it('accepts batch-style unknown jobIds (no local chunked record)', async () => {
    mockGetJob.mockReturnValue(undefined);

    const res = await POST(
      makeReq({ jobId: validJobId, transcript: 'hi', filename: 'a.mp3' }),
    );
    expect(res.status).toBe(200);
    expect(mockBlobStorage.upload).toHaveBeenCalledWith(
      `${userId}/transcripts/${validJobId}.txt`,
      'hi',
      expect.anything(),
    );
  });

  it('accepts a valid chunked job owned by the user', async () => {
    mockGetJob.mockReturnValue({ jobId: validJobId, userId });
    mockGetJobForUser.mockReturnValue({ jobId: validJobId, userId });

    const res = await POST(
      makeReq({ jobId: validJobId, transcript: 'hi', filename: 'a.mp3' }),
    );
    expect(res.status).toBe(200);
  });
});
