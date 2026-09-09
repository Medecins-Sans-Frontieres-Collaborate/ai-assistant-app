import { NextRequest } from 'next/server';

import { deleteBackupPrefix } from '@/lib/services/backup/server/backupBlobStore';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { parseJsonResponse } from './helpers';

import { DELETE } from '@/app/api/backup/route';
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
      deleteBackupPrefix: vi.fn(),
    };
  },
);

const mockSession = {
  user: { id: 'test-user-id', email: 'test@example.com', name: 'Test User' },
  expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};

describe('/api/backup DELETE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(mockSession as any);
    vi.mocked(createBlobStorageClient).mockReturnValue({} as any);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const response = await DELETE(
      new NextRequest('http://localhost:3000/api/backup'),
    );

    expect(response.status).toBe(401);
    expect(deleteBackupPrefix).not.toHaveBeenCalled();
  });

  it('returns 401 for anonymous user id', async () => {
    vi.mocked(auth).mockResolvedValue({
      ...mockSession,
      user: { ...mockSession.user, id: undefined },
    } as any);

    const response = await DELETE(
      new NextRequest('http://localhost:3000/api/backup'),
    );

    expect(response.status).toBe(401);
    expect(deleteBackupPrefix).not.toHaveBeenCalled();
  });

  it('wipes the backup prefix and reports the count', async () => {
    vi.mocked(deleteBackupPrefix).mockResolvedValue(5);

    const response = await DELETE(
      new NextRequest('http://localhost:3000/api/backup'),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({ deleted: 5 });
    expect(deleteBackupPrefix).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-id',
    );
  });

  it('is idempotent — deleting a non-existent backup succeeds with 0', async () => {
    vi.mocked(deleteBackupPrefix).mockResolvedValue(0);

    const response = await DELETE(
      new NextRequest('http://localhost:3000/api/backup'),
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toEqual({ deleted: 0 });
  });
});
