import type { Session } from 'next-auth';

import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBlobClient = {
  url: 'https://test.blob.core.windows.net/c/blob',
  exists: vi.fn(),
  getProperties: vi.fn(),
  upload: vi.fn(),
  stageBlock: vi.fn(),
  commitBlockList: vi.fn(),
  deleteIfExists: vi.fn(),
};

const mockContainerClient = {
  getBlockBlobClient: vi.fn(() => mockBlobClient),
};

const mockBlobServiceClient = {
  getContainerClient: vi.fn(() => mockContainerClient),
};

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(function () {
    return {};
  }),
}));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: vi.fn(function () {
    return mockBlobServiceClient;
  }),
  StorageSharedKeyCredential: vi.fn(),
  generateBlobSASQueryParameters: vi.fn(() => ({ toString: () => '' })),
  BlobSASPermissions: { parse: vi.fn() },
}));

vi.mock('@azure/storage-queue', () => ({
  QueueServiceClient: vi.fn(function () {
    return {};
  }),
  StorageSharedKeyCredential: vi.fn(),
}));

vi.mock('@/lib/utils/app/env', () => ({
  getEnvVariable: vi.fn(() => 'test-storage'),
}));

vi.mock('@/lib/utils/server/azure/retry', () => ({
  // Tests don't exercise retry behaviour — pass-through wrapper preserves
  // the original promise (resolution or rejection) without any backoff.
  withAzureRetry: vi.fn((op: () => Promise<unknown>) => op()),
}));

const mockUser: Session['user'] = {
  id: 'u',
  email: 'u@example.com',
  name: 'U',
};

describe('AzureBlobStorage.upload', () => {
  let storage: AzureBlobStorage;
  const blobName = 'u/uploads/files/abc.txt';
  const content = Buffer.from('hello world');

  beforeEach(() => {
    vi.clearAllMocks();
    mockBlobClient.exists.mockResolvedValue(false);
    mockBlobClient.getProperties.mockResolvedValue({
      contentLength: content.length,
    });
    mockBlobClient.stageBlock.mockResolvedValue(undefined);
    mockBlobClient.commitBlockList.mockResolvedValue(undefined);
    mockBlobClient.deleteIfExists.mockResolvedValue({ succeeded: true });
    mockContainerClient.getBlockBlobClient.mockReturnValue(mockBlobClient);
    storage = new AzureBlobStorage('acct', 'container', mockUser);
  });

  it('returns existing URL on healthy cache hit (size matches) without re-uploading', async () => {
    mockBlobClient.exists.mockResolvedValue(true);
    mockBlobClient.getProperties.mockResolvedValue({
      contentLength: content.length,
    });

    const url = await storage.upload(blobName, content);

    expect(url).toBe(mockBlobClient.url);
    expect(mockBlobClient.stageBlock).not.toHaveBeenCalled();
    expect(mockBlobClient.commitBlockList).not.toHaveBeenCalled();
    expect(mockBlobClient.deleteIfExists).not.toHaveBeenCalled();
  });

  it('replaces a poisoned blob when the existing size does not match', async () => {
    mockBlobClient.exists.mockResolvedValue(true);
    mockBlobClient.getProperties.mockResolvedValue({ contentLength: 3 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await storage.upload(blobName, content);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('poisoned cache'),
    );
    expect(mockBlobClient.deleteIfExists).toHaveBeenCalledTimes(1);
    expect(mockBlobClient.stageBlock).toHaveBeenCalledTimes(1);
    expect(mockBlobClient.commitBlockList).toHaveBeenCalledTimes(1);
    expect(url).toBe(mockBlobClient.url);

    warnSpy.mockRestore();
  });

  it('sanitizes the blob name in the poisoned-cache warning (no CRLF / control chars)', async () => {
    // CodeQL flagged this warn for log injection because blobName carries a
    // user-controlled extension. Verify sanitizeForLog strips the danger.
    const taintedName = 'u/uploads/files/abc.\r\nFAKE LOG ENTRY\x1b[31m.txt';
    mockBlobClient.exists.mockResolvedValue(true);
    mockBlobClient.getProperties.mockResolvedValue({ contentLength: 3 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await storage.upload(taintedName, content);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0] as string;
    expect(logged).not.toMatch(/[\r\n]/);
    expect(logged).not.toMatch(/\x1b/);
    expect(logged).toContain('FAKE LOG ENTRY');

    warnSpy.mockRestore();
  });

  it('uploads via stage + commit when no cached blob exists', async () => {
    mockBlobClient.exists.mockResolvedValue(false);

    const url = await storage.upload(blobName, content, {
      blobHTTPHeaders: { blobContentType: 'text/plain' },
    });

    expect(mockBlobClient.stageBlock).toHaveBeenCalledTimes(1);
    const [stagedId, stagedContent, stagedLength] =
      mockBlobClient.stageBlock.mock.calls[0];
    expect(typeof stagedId).toBe('string');
    expect(stagedContent).toBe(content);
    expect(stagedLength).toBe(content.length);

    expect(mockBlobClient.commitBlockList).toHaveBeenCalledTimes(1);
    const [committedIds, committedOpts] =
      mockBlobClient.commitBlockList.mock.calls[0];
    expect(committedIds).toEqual([stagedId]);
    expect(committedOpts).toEqual({
      blobHTTPHeaders: { blobContentType: 'text/plain' },
    });

    expect(mockBlobClient.upload).not.toHaveBeenCalled();
    expect(url).toBe(mockBlobClient.url);
  });

  it('does not commit (so the blob never becomes visible) when stageBlock fails', async () => {
    mockBlobClient.exists.mockResolvedValue(false);
    mockBlobClient.stageBlock.mockRejectedValue(new Error('stage boom'));

    await expect(storage.upload(blobName, content)).rejects.toThrow(
      'stage boom',
    );
    expect(mockBlobClient.commitBlockList).not.toHaveBeenCalled();
  });

  it('propagates commit failure (caller observes the error; uncommitted blocks GC after 7d)', async () => {
    mockBlobClient.exists.mockResolvedValue(false);
    mockBlobClient.commitBlockList.mockRejectedValue(new Error('commit boom'));

    await expect(storage.upload(blobName, content)).rejects.toThrow(
      'commit boom',
    );
    expect(mockBlobClient.stageBlock).toHaveBeenCalledTimes(1);
  });

  it('handles string content (UTF-8 byte length, not character count)', async () => {
    mockBlobClient.exists.mockResolvedValue(false);
    const utf8 = 'café'; // 5 bytes (é = 2 bytes in UTF-8)

    await storage.upload(blobName, utf8);

    const [, stagedContent, stagedLength] =
      mockBlobClient.stageBlock.mock.calls[0];
    expect(stagedContent).toBe(utf8);
    expect(stagedLength).toBe(5);
  });
});
