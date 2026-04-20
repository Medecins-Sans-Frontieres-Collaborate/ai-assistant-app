import { NextRequest } from 'next/server';

import {
  cancelJob,
  getJobForUser,
} from '@/lib/services/transcription/chunkedJobStore';

import { parseJsonResponse } from './helpers';

import { POST } from '@/app/api/transcription/cancel/[jobId]/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

vi.mock('@/lib/services/transcription/chunkedJobStore', () => ({
  cancelJob: vi.fn(),
  getJobForUser: vi.fn(),
}));

describe('/api/transcription/cancel/[jobId]', () => {
  const ownerId = 'owner-user';
  const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const session = {
    user: { id: ownerId, email: 'a@b.c', name: 'a' },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(session as any);
  });

  const makeReq = () =>
    new NextRequest(`http://localhost/api/transcription/cancel/${jobId}`, {
      method: 'POST',
    });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const res = await POST(makeReq(), {
      params: Promise.resolve({ jobId }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-UUID jobId', async () => {
    const res = await POST(makeReq(), {
      params: Promise.resolve({ jobId: 'nope' }),
    });
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(400);
    expect(data.details).toBe('INVALID_JOB_ID');
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('returns 404 when the job is not owned by this user', async () => {
    vi.mocked(getJobForUser).mockReturnValue(undefined);
    const res = await POST(makeReq(), {
      params: Promise.resolve({ jobId }),
    });
    expect(res.status).toBe(404);
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('cancels an owned job and returns 200', async () => {
    vi.mocked(getJobForUser).mockReturnValue({
      jobId,
      userId: ownerId,
      status: 'processing',
    } as any);
    const res = await POST(makeReq(), {
      params: Promise.resolve({ jobId }),
    });
    expect(res.status).toBe(200);
    expect(cancelJob).toHaveBeenCalledWith(jobId);
  });
});
