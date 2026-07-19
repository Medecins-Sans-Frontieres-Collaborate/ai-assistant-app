import { NextRequest } from 'next/server';

import {
  readBlob,
  writeImmutableBlob,
} from '@/lib/services/backup/server/backupBlobStore';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { parseJsonResponse } from './helpers';

import { DELETE, GET, PUT } from '@/app/api/backup/folders/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));

vi.mock(
  '@/lib/services/backup/server/backupBlobStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/backup/server/backupBlobStore')
      >();
    return {
      ...actual,
      readBlob: vi.fn(),
      writeImmutableBlob: vi.fn(),
    };
  },
);

const mockSession = {
  user: { id: 'test-user-id', email: 'test@example.com', name: 'Test User' },
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

const REV = 'fedcba9876543210';
const EXPECTED_PATH = `test-user-id/backup/folders.${REV}.bin`;

const mockStorage = { deleteIfExists: vi.fn() };

function makeRequest(options: {
  method: string;
  rev?: string | null;
  body?: string | Uint8Array;
}): NextRequest {
  const { method, rev = REV, body } = options;
  const query = rev === null ? '' : `?rev=${rev}`;
  return new NextRequest(`http://localhost:3000/api/backup/folders${query}`, {
    method,
    body,
  });
}

describe('/api/backup/folders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(createBlobStorageClient).mockReturnValue(mockStorage as any);
    vi.mocked(writeImmutableBlob).mockResolvedValue(undefined);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const response = await PUT(makeRequest({ method: 'PUT', body: 'ct' }));

    expect(response.status).toBe(401);
    expect(writeImmutableBlob).not.toHaveBeenCalled();
  });

  it('returns 400 when rev is missing or malformed', async () => {
    const missing = await PUT(
      makeRequest({ method: 'PUT', rev: null, body: 'ct' }),
    );
    const malformed = await GET(makeRequest({ method: 'GET', rev: '../x' }));

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  it('returns 413 when the body exceeds 10MB', async () => {
    const response = await PUT(
      makeRequest({
        method: 'PUT',
        body: new Uint8Array(10 * 1024 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(writeImmutableBlob).not.toHaveBeenCalled();
  });

  it('PUT writes the immutable folders blob', async () => {
    const response = await PUT(makeRequest({ method: 'PUT', body: 'folders' }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({ size: 7 });
    expect(writeImmutableBlob).toHaveBeenCalledWith(
      mockStorage,
      EXPECTED_PATH,
      expect.any(Buffer),
    );
  });

  it('GET returns 404 when absent and bytes when present', async () => {
    vi.mocked(readBlob).mockResolvedValueOnce(null);
    const missing = await GET(makeRequest({ method: 'GET' }));
    expect(missing.status).toBe(404);
    expect((await parseJsonResponse(missing)).code).toBe('BACKUP_NOT_FOUND');

    vi.mocked(readBlob).mockResolvedValueOnce(Buffer.from('folders'));
    const found = await GET(makeRequest({ method: 'GET' }));
    expect(found.status).toBe(200);
    expect(Buffer.from(await found.arrayBuffer()).toString('utf8')).toBe(
      'folders',
    );
  });

  it('DELETE is idempotent', async () => {
    mockStorage.deleteIfExists.mockResolvedValueOnce(false);

    const response = await DELETE(makeRequest({ method: 'DELETE' }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({ deleted: false });
    expect(mockStorage.deleteIfExists).toHaveBeenCalledWith(EXPECTED_PATH);
  });
});
