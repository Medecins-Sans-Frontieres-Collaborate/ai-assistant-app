import { NextRequest } from 'next/server';

import {
  readBlob,
  writeImmutableBlob,
} from '@/lib/services/backup/server/backupBlobStore';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { parseJsonResponse } from './helpers';

import { DELETE, GET, PUT } from '@/app/api/backup/conversations/[id]/route';
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

const REV = '0123456789abcdef';
const EXPECTED_PATH = `test-user-id/backup/conv/conv1.${REV}.bin`;

const mockStorage = { deleteIfExists: vi.fn() };

function makeRequest(options: {
  method: string;
  rev?: string | null;
  body?: string | Uint8Array;
}): NextRequest {
  const { method, rev = REV, body } = options;
  const query = rev === null ? '' : `?rev=${rev}`;
  return new NextRequest(
    `http://localhost:3000/api/backup/conversations/conv1${query}`,
    { method, body },
  );
}

const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/backup/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(createBlobStorageClient).mockReturnValue(mockStorage as any);
    vi.mocked(writeImmutableBlob).mockResolvedValue(undefined);
  });

  it('returns 401 when unauthenticated (all methods)', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const put = await PUT(
      makeRequest({ method: 'PUT', body: 'ct' }),
      paramsFor('conv1'),
    );
    const get = await GET(makeRequest({ method: 'GET' }), paramsFor('conv1'));
    const del = await DELETE(
      makeRequest({ method: 'DELETE' }),
      paramsFor('conv1'),
    );

    expect(put.status).toBe(401);
    expect(get.status).toBe(401);
    expect(del.status).toBe(401);
    expect(writeImmutableBlob).not.toHaveBeenCalled();
  });

  it.each(['../evil', 'a/b', 'a.b', '', 'x'.repeat(65)])(
    'returns 400 for invalid conversation id %j',
    async (id) => {
      const response = await PUT(
        makeRequest({ method: 'PUT', body: 'ct' }),
        paramsFor(id),
      );

      expect(response.status).toBe(400);
      expect(writeImmutableBlob).not.toHaveBeenCalled();
    },
  );

  it('returns 400 when rev is missing or malformed', async () => {
    const missing = await PUT(
      makeRequest({ method: 'PUT', rev: null, body: 'ct' }),
      paramsFor('conv1'),
    );
    const malformed = await PUT(
      makeRequest({ method: 'PUT', rev: 'NOT-HEX', body: 'ct' }),
      paramsFor('conv1'),
    );

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(writeImmutableBlob).not.toHaveBeenCalled();
  });

  describe('PUT', () => {
    it('returns 413 when the body exceeds 10MB', async () => {
      const response = await PUT(
        makeRequest({
          method: 'PUT',
          body: new Uint8Array(10 * 1024 * 1024 + 1),
        }),
        paramsFor('conv1'),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(413);
      expect(data.code).toBe('PAYLOAD_TOO_LARGE');
      expect(writeImmutableBlob).not.toHaveBeenCalled();
    });

    it('returns 400 for an empty body', async () => {
      const response = await PUT(
        makeRequest({ method: 'PUT', body: new Uint8Array(0) }),
        paramsFor('conv1'),
      );

      expect(response.status).toBe(400);
    });

    it('writes the immutable blob at the validated path', async () => {
      const response = await PUT(
        makeRequest({ method: 'PUT', body: 'ciphertext' }),
        paramsFor('conv1'),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ size: 10 });
      expect(writeImmutableBlob).toHaveBeenCalledWith(
        mockStorage,
        EXPECTED_PATH,
        expect.any(Buffer),
      );
    });
  });

  describe('GET', () => {
    it('returns 404 BACKUP_NOT_FOUND when the blob does not exist', async () => {
      vi.mocked(readBlob).mockResolvedValue(null);

      const response = await GET(
        makeRequest({ method: 'GET' }),
        paramsFor('conv1'),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.code).toBe('BACKUP_NOT_FOUND');
    });

    it('streams the ciphertext back as octet-stream', async () => {
      vi.mocked(readBlob).mockResolvedValue(Buffer.from('ciphertext'));

      const response = await GET(
        makeRequest({ method: 'GET' }),
        paramsFor('conv1'),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'application/octet-stream',
      );
      expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe(
        'ciphertext',
      );
      expect(readBlob).toHaveBeenCalledWith(mockStorage, EXPECTED_PATH);
    });
  });

  describe('DELETE', () => {
    it('is idempotent — succeeds whether or not the blob existed', async () => {
      mockStorage.deleteIfExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const first = await DELETE(
        makeRequest({ method: 'DELETE' }),
        paramsFor('conv1'),
      );
      const second = await DELETE(
        makeRequest({ method: 'DELETE' }),
        paramsFor('conv1'),
      );

      expect(first.status).toBe(200);
      expect((await parseJsonResponse(first)).data).toEqual({ deleted: true });
      expect(second.status).toBe(200);
      expect((await parseJsonResponse(second)).data).toEqual({
        deleted: false,
      });
      expect(mockStorage.deleteIfExists).toHaveBeenCalledWith(EXPECTED_PATH);
    });
  });
});
