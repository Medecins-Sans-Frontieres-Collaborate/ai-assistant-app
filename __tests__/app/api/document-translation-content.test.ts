import { NextRequest } from 'next/server';

import { createMockSession } from './helpers';

import { GET } from '@/app/api/document-translation/content/[jobId]/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockBlobExists = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/utils/app/env', () => ({
  getEnvVariable: () => 'test-storage',
}));
vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: class {
    blobExists = mockBlobExists;
    get = mockGet;
  },
  BlobProperty: { BLOB: 'BLOB', URL: 'URL' },
}));

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'test-user-id';

function contentRequest(query: string) {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/document-translation/content/${JOB_ID}?${query}`,
    ),
    { params: Promise.resolve({ jobId: JOB_ID }) },
  );
}

describe('GET /api/document-translation/content/[jobId] (path safety)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession(USER_ID));
    mockBlobExists.mockResolvedValue(true);
    mockGet.mockResolvedValue(Buffer.from('file-bytes'));
  });

  it('401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await contentRequest('ext=pdf')).status).toBe(401);
  });

  it('rejects a non-UUID jobId', async () => {
    const res = await GET(
      new NextRequest(
        'http://localhost:3000/api/document-translation/content/x',
      ),
      { params: Promise.resolve({ jobId: '../../secret' }) },
    );
    expect(res.status).toBe(404);
    expect(mockBlobExists).not.toHaveBeenCalled();
  });

  it('builds the blob path inside the user/job slot for a normal ext', async () => {
    await contentRequest('ext=pdf&filename=report.pdf');
    expect(mockBlobExists).toHaveBeenCalledWith(
      `${USER_ID}/translations/${JOB_ID}.pdf`,
    );
  });

  it('neutralizes a traversal payload in the ext query param', async () => {
    // Attacker tries to escape the slot to read another user's data / an
    // arbitrary blob. The sanitized ext can carry no separator or dot, so the
    // path stays anchored to `${userId}/translations/${jobId}.<safe>`.
    await contentRequest(
      'ext=pdf%2F..%2F..%2F..%2Fother-user%2Fsecret&filename=x',
    );
    const requestedPath = mockBlobExists.mock.calls[0][0] as string;
    expect(requestedPath.startsWith(`${USER_ID}/translations/${JOB_ID}.`)).toBe(
      true,
    );
    expect(requestedPath).not.toContain('..');
    expect(requestedPath).not.toContain('other-user');
    // Exactly one dot-separated, alphanumeric, length-capped segment after
    // the job id — no separators survived to re-anchor the path.
    expect(requestedPath).toBe(
      `${USER_ID}/translations/${JOB_ID}.pdfotheruser`,
    );
  });

  it('falls back to a default ext when the param is all-stripped', async () => {
    await contentRequest('ext=..%2F..%2F');
    expect(mockBlobExists).toHaveBeenCalledWith(
      `${USER_ID}/translations/${JOB_ID}.txt`,
    );
  });
});
