import { FileUploadService } from '@/client/services/fileUploadService';

import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const session: ChunkedUploadSession = {
  sessionId: 'sess-1',
  blobPath: 'user/uploads/files/sess-1.mp4',
  totalChunks: 5,
  chunkSize: 10 * 1024 * 1024,
  filename: 'test.mp4',
  filetype: 'video',
  mimeType: 'video/mp4',
  totalSize: 50 * 1024 * 1024,
};

const initMock = vi.fn(async () => ({ success: true, session }));
const chunkMock = vi.fn(
  async (
    _: unknown,
    chunkIndex: number,
  ): Promise<{
    success: boolean;
    chunkIndex: number;
    error?: string;
  }> => ({ success: true, chunkIndex }),
);
const finalizeMock = vi.fn(async () => ({
  success: true,
  uri: 'https://blob.local/test.mp4',
}));

vi.mock('@/lib/actions/fileUpload', () => ({
  initChunkedUploadAction: (...args: unknown[]) => initMock(...args),
  uploadChunkAction: (...args: unknown[]) => chunkMock(...args),
  finalizeChunkedUploadAction: (...args: unknown[]) => finalizeMock(...args),
  uploadFileAction: vi.fn(),
}));

// Minimal File-like stub: the chunked path only reads `.size`, `.slice`,
// `.name`, and `.type`. We don't need real Blob content because
// uploadChunkAction is mocked.
function fakeVideoFile(size: number): File {
  return {
    size,
    name: 'test.mp4',
    type: 'video/mp4',
    slice(start: number, end: number) {
      return { size: end - start } as unknown as Blob;
    },
  } as unknown as File;
}

const FIVE_CHUNKS_50MB = 50 * 1024 * 1024;

function wait(ms = 5) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('FileUploadService chunked parallel upload', () => {
  beforeEach(() => {
    initMock.mockClear();
    finalizeMock.mockClear();
    chunkMock.mockReset();
    chunkMock.mockImplementation(
      async (_session: unknown, chunkIndex: number) => ({
        success: true,
        chunkIndex,
      }),
    );
  });

  it('commits all chunks and reports monotonic progress when chunks resolve out of order', async () => {
    // Make odd-indexed chunks resolve after a delay so they land last.
    chunkMock.mockImplementation(
      async (_session: unknown, chunkIndex: number) => {
        if (chunkIndex % 2 === 1) await wait(10);
        return { success: true, chunkIndex };
      },
    );

    const onProgress = vi.fn();
    const result = await FileUploadService.uploadFile(
      fakeVideoFile(FIVE_CHUNKS_50MB),
      onProgress,
    );

    expect(result.url).toBe('https://blob.local/test.mp4');
    expect(chunkMock).toHaveBeenCalledTimes(5);
    expect(finalizeMock).toHaveBeenCalledOnce();

    // Every chunk index 0..4 was uploaded exactly once.
    const uploadedIndexes = chunkMock.mock.calls
      .map((c) => c[1] as number)
      .sort();
    expect(uploadedIndexes).toEqual([0, 1, 2, 3, 4]);

    // Progress values only ever increase.
    const progressValues = onProgress.mock.calls.map((c) => c[0] as number);
    const sorted = [...progressValues].sort((a, b) => a - b);
    expect(progressValues).toEqual(sorted);
    expect(progressValues[progressValues.length - 1]).toBe(100);
  });

  it('surfaces the first chunk failure and still finalizes nothing', async () => {
    chunkMock.mockImplementation(
      async (_session: unknown, chunkIndex: number) => {
        if (chunkIndex === 2) {
          return { success: false, chunkIndex, error: 'boom' };
        }
        return { success: true, chunkIndex };
      },
    );

    await expect(
      FileUploadService.uploadFile(fakeVideoFile(FIVE_CHUNKS_50MB)),
    ).rejects.toThrow(/boom/);

    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('caps concurrency at the configured worker count (≤4 in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    chunkMock.mockImplementation(
      async (_session: unknown, chunkIndex: number) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await wait(5);
        inFlight--;
        return { success: true, chunkIndex };
      },
    );

    await FileUploadService.uploadFile(fakeVideoFile(FIVE_CHUNKS_50MB));

    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});
