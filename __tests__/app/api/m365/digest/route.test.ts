/**
 * POST /api/m365/digest — validation, the per-day budget, and the job kick.
 * GET /api/m365/digest/{jobId} — ownership-scoped reads.
 */
import { NextRequest } from 'next/server';

import { guardLimit } from '@/lib/services/limits/routeGuard';
import {
  DigestBusyError,
  deleteDigestJobForUser,
  getDigestJobForUser,
} from '@/lib/services/m365/digest/digestJobStore';
import { startDigestJob } from '@/lib/services/m365/digest/digestService';
import { M365Error, mintGraphToken } from '@/lib/services/m365/graphApi';

import { parseJsonResponse } from '../../helpers';

import { DELETE, GET } from '@/app/api/m365/digest/[jobId]/route';
import { POST } from '@/app/api/m365/digest/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/limits/routeGuard', () => ({ guardLimit: vi.fn() }));
vi.mock('@/lib/services/m365/digest/digestService', () => ({
  startDigestJob: vi.fn(),
}));
vi.mock(
  '@/lib/services/m365/digest/digestJobStore',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/lib/services/m365/digest/digestJobStore')
    >()),
    getDigestJobForUser: vi.fn(),
    deleteDigestJobForUser: vi.fn(),
  }),
);
vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/m365/graphApi')>()),
  mintGraphToken: vi.fn().mockResolvedValue('token'),
}));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(() => ({})),
}));

const JOB = '11111111-2222-4333-8444-555555555555';
const T1 = 'aaaaaaaa-1111-4111-8111-111111111111';

function post(body: unknown) {
  return new NextRequest('http://localhost/api/m365/digest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validWindow = () => ({
  startIso: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  endIso: new Date().toISOString(),
  preset: '7d',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'me@example.org' } });
  vi.mocked(guardLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(startDigestJob).mockResolvedValue({
    jobId: JOB,
    status: 'pending',
  } as never);
  vi.mocked(mintGraphToken).mockResolvedValue('token');
});

describe('POST /api/m365/digest', () => {
  it('rejects anonymous callers', async () => {
    mockAuth.mockResolvedValue(null);
    const response = await POST(post({}));
    expect(response.status).toBe(401);
  });

  it('rejects a malformed window, no sources, and more than 10 channels', async () => {
    expect((await POST(post({ window: {}, sources: ['mail'] }))).status).toBe(
      400,
    );
    expect(
      (await POST(post({ window: validWindow(), sources: [] }))).status,
    ).toBe(400);
    const channels = Array.from({ length: 11 }, (_, i) => ({
      teamId: T1,
      channelId: `19:chan${i}@thread.tacv2`,
      name: `C${i}`,
    }));
    const response = await POST(
      post({ window: validWindow(), sources: ['channel'], channels }),
    );
    expect(response.status).toBe(400);
    expect(startDigestJob).not.toHaveBeenCalled();
  });

  it('enforces the per-day run budget before starting anything', async () => {
    vi.mocked(guardLimit).mockResolvedValue({
      allowed: false,
      response: new Response(null, { status: 429 }),
    } as never);
    const response = await POST(
      post({ window: validWindow(), sources: ['mail'] }),
    );
    expect(response.status).toBe(429);
    expect(guardLimit).toHaveBeenCalledWith(
      expect.anything(),
      'feature.m365.digestRunsPerDay',
      expect.objectContaining({ req: expect.anything() }),
    );
    expect(startDigestJob).not.toHaveBeenCalled();
  });

  it('starts the job with deduped sources and channels dropped when the source is off', async () => {
    const response = await POST(
      post({
        window: validWindow(),
        sources: ['mail', 'mail', 'bogus', 'calendar'],
        channels: [
          { teamId: T1, channelId: '19:abc@thread.tacv2', name: 'General' },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse<{ data: { jobId: string } }>(
      response,
    );
    expect(data.jobId).toBe(JOB);
    const request = vi.mocked(startDigestJob).mock.calls[0][2];
    expect(request.sources).toEqual(['mail', 'calendar']);
    expect(request.channels).toEqual([]);
  });
});

describe('POST /api/m365/digest guards', () => {
  it('400s a non-object body instead of crashing', async () => {
    expect((await POST(post(null))).status).toBe(400);
    expect((await POST(post([1]))).status).toBe(400);
  });

  it('fails a disconnected account before charging a run', async () => {
    vi.mocked(mintGraphToken).mockRejectedValue(
      new M365Error('No Microsoft 365 session', 'not_connected', 401),
    );
    const response = await POST(
      post({ window: validWindow(), sources: ['mail'] }),
    );
    expect(response.status).toBe(401);
    expect(guardLimit).not.toHaveBeenCalled();
    expect(startDigestJob).not.toHaveBeenCalled();
  });

  it('409s while another digest is running and refunds the run', async () => {
    const rollback = vi.fn();
    vi.mocked(guardLimit).mockResolvedValue({
      allowed: true,
      rollback,
    } as never);
    vi.mocked(startDigestJob).mockRejectedValue(new DigestBusyError(JOB));
    const response = await POST(
      post({ window: validWindow(), sources: ['mail'] }),
    );
    expect(response.status).toBe(409);
    expect(rollback).toHaveBeenCalled();
  });
});

describe('DELETE /api/m365/digest/{jobId}', () => {
  const del = (jobId: string) =>
    DELETE(
      new NextRequest(`http://localhost/api/m365/digest/${jobId}`, {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({ jobId }),
      },
    );

  it("deletes the owner's record, 404s others, 400s malformed ids", async () => {
    vi.mocked(deleteDigestJobForUser).mockResolvedValue(true);
    expect((await del(JOB)).status).toBe(200);
    expect(deleteDigestJobForUser).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      JOB,
    );
    vi.mocked(deleteDigestJobForUser).mockResolvedValue(false);
    expect((await del(JOB)).status).toBe(404);
    expect((await del('nope')).status).toBe(400);
  });
});

describe('GET /api/m365/digest/{jobId}', () => {
  const get = (jobId: string) =>
    GET(new NextRequest(`http://localhost/api/m365/digest/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

  it('404s unknown or foreign jobs and 400s malformed ids', async () => {
    vi.mocked(getDigestJobForUser).mockResolvedValue(undefined);
    expect((await get(JOB)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(400);
  });

  it('returns progress and result for the owner', async () => {
    vi.mocked(getDigestJobForUser).mockResolvedValue({
      jobId: JOB,
      userId: 'u1',
      status: 'succeeded',
      progress: { stage: 'done', sources: [] },
      result: { version: 1, items: [] },
    } as never);
    const response = await get(JOB);
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse<{
      data: { status: string; result: { version: number } };
    }>(response);
    expect(data.status).toBe('succeeded');
    expect(data.result.version).toBe(1);
    expect(getDigestJobForUser).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      JOB,
    );
  });
});
