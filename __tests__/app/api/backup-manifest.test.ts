import { NextRequest } from 'next/server';

import {
  BackupConflictError,
  readManifest,
  writeManifest,
} from '@/lib/services/backup/server/backupBlobStore';
import { BackupManifest } from '@/lib/services/backup/types';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { parseJsonResponse } from './helpers';

import { GET, PUT } from '@/app/api/backup/manifest/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));

// Keep validators + BackupConflictError real; mock only the blob accessors.
vi.mock(
  '@/lib/services/backup/server/backupBlobStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/backup/server/backupBlobStore')
      >();
    return {
      ...actual,
      readManifest: vi.fn(),
      writeManifest: vi.fn(),
    };
  },
);

const mockSession = {
  user: { id: 'test-user-id', email: 'test@example.com', name: 'Test User' },
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

const KEY_A = 'aabbccddeeff0011';
const KEY_B = '1100ffeeddccbbaa';
const REV = '0123456789abcdef';

function makeManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    schemaVersion: 1,
    keyId: KEY_A,
    epoch: 1,
    version: 2,
    updatedAt: '2026-07-17T00:00:00.000Z',
    folders: null,
    conversations: {
      conv1: { rev: REV, updatedAt: '2026-07-17T00:00:00.000Z', size: 42 },
    },
    ...overrides,
  };
}

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/backup/manifest', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

describe('/api/backup/manifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(createBlobStorageClient).mockReturnValue({} as any);
    vi.mocked(writeManifest).mockResolvedValue('"etag-new"');
  });

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth).mockResolvedValue(null as any);

      const response = await GET();

      expect(response.status).toBe(401);
      expect(readManifest).not.toHaveBeenCalled();
    });

    it('returns 401 for anonymous user id', async () => {
      vi.mocked(auth).mockResolvedValue({
        ...mockSession,
        user: { ...mockSession.user, id: undefined },
      } as any);

      const response = await GET();

      expect(response.status).toBe(401);
    });

    it('returns 404 BACKUP_NOT_FOUND when no manifest exists', async () => {
      vi.mocked(readManifest).mockResolvedValue(null);

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.code).toBe('BACKUP_NOT_FOUND');
    });

    it('returns manifest and etag', async () => {
      const manifest = makeManifest();
      vi.mocked(readManifest).mockResolvedValue({ manifest, etag: '"e1"' });

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ manifest, etag: '"e1"' });
    });
  });

  describe('PUT', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth).mockResolvedValue(null as any);

      const response = await PUT(putRequest(makeManifest()));

      expect(response.status).toBe(401);
      expect(writeManifest).not.toHaveBeenCalled();
    });

    it('returns 413 when the body exceeds 1MB', async () => {
      const response = await PUT(putRequest('x'.repeat(1024 * 1024 + 1)));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(413);
      expect(data.code).toBe('PAYLOAD_TOO_LARGE');
      expect(writeManifest).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON', async () => {
      const response = await PUT(putRequest('{not json'));

      expect(response.status).toBe(400);
    });

    it.each([
      ['wrong schemaVersion', { schemaVersion: 2 }],
      ['bad keyId', { keyId: 'nope' }],
      ['null keyId without disabled', { keyId: null }],
      ['non-integer epoch', { epoch: 1.5 }],
      ['zero version', { version: 0 }],
      ['bad folders rev', { folders: { rev: 'XYZ', updatedAt: 'now' } }],
      [
        'traversal conversation id',
        {
          conversations: {
            '../evil': { rev: REV, updatedAt: 'now', size: 1 },
          },
        },
      ],
      [
        'bad conversation rev',
        {
          conversations: { conv1: { rev: 'short', updatedAt: 'now', size: 1 } },
        },
      ],
    ])('returns 400 for shape violation: %s', async (_label, overrides) => {
      const response = await PUT(
        putRequest(makeManifest(overrides as Partial<BackupManifest>)),
      );

      expect(response.status).toBe(400);
      expect(writeManifest).not.toHaveBeenCalled();
    });

    it('accepts a disabled tombstone manifest with null keyId', async () => {
      vi.mocked(readManifest).mockResolvedValue({
        manifest: makeManifest({ version: 4 }),
        etag: '"e1"',
      });

      const response = await PUT(
        putRequest(
          makeManifest({
            disabled: true,
            keyId: null,
            epoch: 2,
            version: 5,
            conversations: {},
          }),
          { 'if-match': '"e1"' },
        ),
      );

      expect(response.status).toBe(200);
      expect(writeManifest).toHaveBeenCalled();
    });

    it('returns 409 when a manifest exists but If-Match is missing', async () => {
      vi.mocked(readManifest).mockResolvedValue({
        manifest: makeManifest({ version: 1 }),
        etag: '"e1"',
      });

      const response = await PUT(putRequest(makeManifest({ version: 2 })));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('BACKUP_VERSION_CONFLICT');
      expect(writeManifest).not.toHaveBeenCalled();
    });

    it('returns 409 BACKUP_KEY_MISMATCH when keyId changes without epoch+1', async () => {
      vi.mocked(readManifest).mockResolvedValue({
        manifest: makeManifest({ keyId: KEY_A, epoch: 3, version: 7 }),
        etag: '"e1"',
      });

      const response = await PUT(
        putRequest(makeManifest({ keyId: KEY_B, epoch: 3, version: 8 }), {
          'if-match': '"e1"',
        }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('BACKUP_KEY_MISMATCH');
      expect(writeManifest).not.toHaveBeenCalled();
    });

    it('allows a keyId change with exactly epoch+1', async () => {
      vi.mocked(readManifest).mockResolvedValue({
        manifest: makeManifest({ keyId: KEY_A, epoch: 3, version: 7 }),
        etag: '"e1"',
      });

      const response = await PUT(
        putRequest(makeManifest({ keyId: KEY_B, epoch: 4, version: 8 }), {
          'if-match': '"e1"',
        }),
      );

      expect(response.status).toBe(200);
      expect(writeManifest).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        expect.objectContaining({ keyId: KEY_B, epoch: 4, version: 8 }),
        '"e1"',
      );
    });

    it.each([
      ['same version', 7],
      ['skipped version', 9],
      ['older version', 3],
    ])(
      'returns 400 when version is not exactly +1 (%s)',
      async (_label, version) => {
        vi.mocked(readManifest).mockResolvedValue({
          manifest: makeManifest({ version: 7 }),
          etag: '"e1"',
        });

        const response = await PUT(
          putRequest(makeManifest({ version }), { 'if-match': '"e1"' }),
        );

        expect(response.status).toBe(400);
        expect(writeManifest).not.toHaveBeenCalled();
      },
    );

    it('requires version 1 on first create and writes with null etag', async () => {
      vi.mocked(readManifest).mockResolvedValue(null);

      const bad = await PUT(putRequest(makeManifest({ version: 2 })));
      expect(bad.status).toBe(400);

      const response = await PUT(putRequest(makeManifest({ version: 1 })));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ etag: '"etag-new"', version: 1 });
      expect(writeManifest).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        expect.objectContaining({ version: 1 }),
        null,
      );
    });

    it('maps a lost CAS race (BackupConflictError) to 409 BACKUP_VERSION_CONFLICT', async () => {
      vi.mocked(readManifest).mockResolvedValue({
        manifest: makeManifest({ version: 7 }),
        etag: '"e1"',
      });
      vi.mocked(writeManifest).mockRejectedValue(new BackupConflictError());

      const response = await PUT(
        putRequest(makeManifest({ version: 8 }), { 'if-match': '"e1"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('BACKUP_VERSION_CONFLICT');
    });
  });
});
