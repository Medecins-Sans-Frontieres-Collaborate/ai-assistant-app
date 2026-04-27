import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import { cancelChunkedUploadAction } from '@/lib/actions/fileUpload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before the import-under-test.
const authMock = vi.fn();
const verifyChunkedSessionMock = vi.fn();
const deleteIfExistsMock = vi.fn();

vi.mock('@/auth', () => ({
  auth: () => authMock(),
}));

vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: () => 'user-1',
}));

vi.mock('@/lib/utils/server/upload/chunkedSessionSigning', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/utils/server/upload/chunkedSessionSigning')
  >('@/lib/utils/server/upload/chunkedSessionSigning');
  return {
    ...actual,
    verifyChunkedSession: (...args: unknown[]) =>
      verifyChunkedSessionMock(...args),
  };
});

vi.mock('@/lib/utils/server/blob/blob', () => {
  // The action checks `instanceof AzureBlobStorage` so the mock must
  // expose a class that the factory below can instantiate.
  class FakeAzureBlobStorage {
    deleteIfExists = (path: string) => deleteIfExistsMock(path);
  }
  return {
    AzureBlobStorage: FakeAzureBlobStorage,
    BlobProperty: { URL: 'url', BLOB: 'blob' },
  };
});

vi.mock('@/lib/services/blobStorageFactory', async () => {
  const blob = (await vi.importMock('@/lib/utils/server/blob/blob')) as {
    AzureBlobStorage: new () => unknown;
  };
  return {
    createBlobStorageClient: () => new blob.AzureBlobStorage(),
  };
});

const baseSession: ChunkedUploadSession = {
  uploadId: 'upload-1',
  filename: 'test.mp4',
  filetype: 'video',
  mimeType: 'video/mp4',
  totalSize: 50 * 1024 * 1024,
  totalChunks: 5,
  chunkSize: 10 * 1024 * 1024,
  blobPath: 'user-1/uploads/files/upload-1.mp4',
  expiresAt: Date.now() + 3_600_000,
  signature: 'sig',
};

describe('cancelChunkedUploadAction', () => {
  beforeEach(() => {
    authMock.mockReset();
    verifyChunkedSessionMock.mockReset();
    deleteIfExistsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Unauthorized when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const result = await cancelChunkedUploadAction(baseSession);

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(deleteIfExistsMock).not.toHaveBeenCalled();
  });

  it('returns the verification error when the session is invalid', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    verifyChunkedSessionMock.mockReturnValue({
      valid: false,
      reason: 'Upload session expired',
    });

    const result = await cancelChunkedUploadAction(baseSession);

    expect(result).toEqual({ success: false, error: 'Upload session expired' });
    expect(deleteIfExistsMock).not.toHaveBeenCalled();
  });

  it('calls deleteIfExists for the session blobPath on success', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    verifyChunkedSessionMock.mockReturnValue({ valid: true });
    deleteIfExistsMock.mockResolvedValue(true);

    const result = await cancelChunkedUploadAction(baseSession);

    expect(result).toEqual({ success: true });
    expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
    expect(deleteIfExistsMock).toHaveBeenCalledWith(baseSession.blobPath);
  });

  it('reports the underlying error when deleteIfExists throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    verifyChunkedSessionMock.mockReturnValue({ valid: true });
    deleteIfExistsMock.mockRejectedValue(new Error('Azure 503'));

    const result = await cancelChunkedUploadAction(baseSession);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Azure 503');
  });
});
