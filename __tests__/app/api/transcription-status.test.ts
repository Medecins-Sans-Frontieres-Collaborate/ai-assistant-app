import { NextRequest } from 'next/server';

import { getJobForUser } from '@/lib/services/transcription/chunkedJobStore';

import { parseJsonResponse } from './helpers';

import { GET } from '@/app/api/transcription/status/[jobId]/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/services/transcription/chunkedJobStore', () => ({
  getJobForUser: vi.fn(),
}));

vi.mock('@/lib/services/transcription/batchTranscriptionService', () => ({
  BatchTranscriptionService: vi.fn().mockImplementation(function (this: any) {
    this.isConfigured = () => false;
    this.getStatus = vi.fn();
    this.getTranscript = vi.fn();
  }),
}));

describe('/api/transcription/status/[jobId]', () => {
  const ownerId = 'owner-user-id';
  const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const mockSession = {
    user: { id: ownerId, email: 'owner@example.com', name: 'Owner' },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(mockSession as any);
  });

  const makeRequest = () =>
    new NextRequest(`http://localhost:3000/api/transcription/status/${jobId}`);

  it('returns 401 without a session', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ jobId }),
    });

    expect(response.status).toBe(401);
  });

  it('returns progress for a chunked job owned by the caller', async () => {
    vi.mocked(getJobForUser).mockReturnValue({
      jobId,
      userId: ownerId,
      status: 'processing',
      totalChunks: 3,
      completedChunks: 1,
      currentChunk: 1,
      chunkPaths: [],
      filename: 'lecture.mp3',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ jobId }),
    });
    const body = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(getJobForUser).toHaveBeenCalledWith(jobId, ownerId);
    expect(body.data?.status ?? body.status).toBe('Running');
    expect(body.data?.progress ?? body.progress).toEqual({
      completed: 1,
      total: 3,
    });
  });

  it('returns 404 when the chunked job belongs to another user', async () => {
    // getJobForUser returns undefined on mismatch to avoid enumeration.
    vi.mocked(getJobForUser).mockReturnValue(undefined);

    const response = await GET(makeRequest(), {
      params: Promise.resolve({ jobId }),
    });

    // Falls through to the batch path; with batch service "not configured"
    // the route returns 404.
    expect(response.status).toBe(404);
    expect(getJobForUser).toHaveBeenCalledWith(jobId, ownerId);
  });

  it('returns 400 when jobId is not a UUID', async () => {
    const response = await GET(makeRequest(), {
      params: Promise.resolve({ jobId: 'not-a-uuid' }),
    });

    expect(response.status).toBe(400);
    expect(getJobForUser).not.toHaveBeenCalled();
  });
});
