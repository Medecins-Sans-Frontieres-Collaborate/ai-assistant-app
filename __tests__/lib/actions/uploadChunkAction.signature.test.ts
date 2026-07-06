import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import { uploadChunkAction } from '@/lib/actions/fileUpload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Magic-byte validation on the chunked upload path. Whole-file uploads have
// always sniffed audio/video content (uploadFileToBlobStorage / upload route),
// but chunked uploads — used for every file >10MB — previously skipped it.
// These tests lock the chunk-0 signature gate added to uploadChunkAction.

// Mocks must be declared before the import-under-test.
const authMock = vi.fn();
const verifyChunkedSessionMock = vi.fn();
const stageBlockMock = vi.fn();

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
    stageBlock = (path: string, blockId: string, data: Buffer) =>
      stageBlockMock(path, blockId, data);
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

const videoSession: ChunkedUploadSession = {
  uploadId: 'upload-1',
  filename: 'recording.mp4',
  filetype: 'video',
  mimeType: 'video/mp4',
  totalSize: 50 * 1024 * 1024,
  totalChunks: 5,
  chunkSize: 10 * 1024 * 1024,
  blobPath: 'user-1/uploads/files/upload-1.mp4',
  expiresAt: Date.now() + 3_600_000,
  signature: 'sig',
};

const documentSession: ChunkedUploadSession = {
  ...videoSession,
  filename: 'report.pdf',
  filetype: 'file',
  mimeType: 'application/pdf',
  blobPath: 'user-1/uploads/files/upload-1.pdf',
};

/** ISO-BMFF header: size box then "ftyp" at offset 4 — valid mp4 magic. */
function mp4Header(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
  ]);
}

function asFormData(buffer: Buffer): FormData {
  const fd = new FormData();
  fd.append('chunk', new Blob([new Uint8Array(buffer)]));
  return fd;
}

describe('uploadChunkAction — chunk-0 magic-byte validation', () => {
  beforeEach(() => {
    authMock.mockReset();
    verifyChunkedSessionMock.mockReset();
    stageBlockMock.mockReset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    verifyChunkedSessionMock.mockReturnValue({ valid: true });
    stageBlockMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts chunk 0 of a video session with a valid mp4 header', async () => {
    const result = await uploadChunkAction(
      videoSession,
      0,
      asFormData(mp4Header()),
    );

    expect(result.success).toBe(true);
    expect(stageBlockMock).toHaveBeenCalledTimes(1);
  });

  it('rejects chunk 0 of an audio/video session whose content is not audio/video', async () => {
    const result = await uploadChunkAction(
      videoSession,
      0,
      asFormData(Buffer.from('#!/bin/sh\necho definitely not a video\n')),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/signature|format/i);
    expect(stageBlockMock).not.toHaveBeenCalled();
  });

  it('does not sniff later chunks (arbitrary media data)', async () => {
    const result = await uploadChunkAction(
      videoSession,
      3,
      asFormData(Buffer.from('arbitrary mid-file bytes with no signature')),
    );

    expect(result.success).toBe(true);
    expect(stageBlockMock).toHaveBeenCalledTimes(1);
  });

  it('does not sniff chunk 0 of non-audio/video sessions', async () => {
    const result = await uploadChunkAction(
      documentSession,
      0,
      asFormData(Buffer.from('%PDF-1.7 not an audio signature')),
    );

    expect(result.success).toBe(true);
    expect(stageBlockMock).toHaveBeenCalledTimes(1);
  });
});
