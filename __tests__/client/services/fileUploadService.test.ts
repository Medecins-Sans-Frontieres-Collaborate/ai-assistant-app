import { FileUploadService } from '@/client/services/fileUploadService';

import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cacheImageBase64Mock = vi.fn();
vi.mock('@/lib/services/imageService', () => ({
  cacheImageBase64: (...args: unknown[]) => cacheImageBase64Mock(...args),
}));

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

describe('FileUploadService.uploadImage', () => {
  type XhrHandlers = Record<string, ((event?: unknown) => void)[]>;

  interface FakeXhr {
    upload: { addEventListener: ReturnType<typeof vi.fn> };
    status: number;
    statusText: string;
    responseText: string;
    open: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    addEventListener: (
      event: string,
      callback: (event?: unknown) => void,
    ) => void;
    _handlers: XhrHandlers;
    _body?: unknown;
  }

  let lastXhr: FakeXhr | null = null;
  const originalXhr = global.XMLHttpRequest;

  function makeFakeXhr({
    succeed = true,
    responseBody = JSON.stringify({ data: { uri: '/api/file/abc.png' } }),
  }: { succeed?: boolean; responseBody?: string } = {}): FakeXhr {
    const handlers: XhrHandlers = {};
    const xhr: FakeXhr = {
      upload: { addEventListener: vi.fn() },
      status: 0,
      statusText: '',
      responseText: '',
      open: vi.fn(),
      send: vi.fn(function (this: FakeXhr, body: unknown) {
        this._body = body;
        if (succeed) {
          this.status = 200;
          this.responseText = responseBody;
          handlers.load?.forEach((cb) => cb());
        } else {
          this.status = 500;
          this.statusText = 'Internal Server Error';
          handlers.load?.forEach((cb) => cb());
        }
      }),
      addEventListener: (event, callback) => {
        handlers[event] ??= [];
        handlers[event].push(callback);
      },
      _handlers: handlers,
    };
    return xhr;
  }

  // Stub readFileAsDataURL rather than depending on jsdom's FileReader, which
  // varies between environments (jsdom version differences caused this test
  // to fail in CI on a real File-backed FileReader despite passing locally).
  let readFileSpy: ReturnType<typeof vi.spyOn>;
  const STUB_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

  beforeEach(() => {
    cacheImageBase64Mock.mockClear();
    lastXhr = null;
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest =
      function (this: unknown) {
        lastXhr = makeFakeXhr();
        return lastXhr;
      } as unknown as typeof XMLHttpRequest;
    readFileSpy = vi
      .spyOn(FileUploadService, 'readFileAsDataURL')
      .mockResolvedValue(STUB_DATA_URL);
  });

  afterEach(() => {
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest =
      originalXhr;
    readFileSpy.mockRestore();
  });

  // Minimal File stub: uploadImage only forwards the file to FormData (which
  // accepts any Blob-like) and to the (mocked) readFileAsDataURL.
  function fakePngFile(): File {
    return {
      name: 'photo.png',
      type: 'image/png',
      size: 16,
    } as unknown as File;
  }

  it('uploads via multipart/form-data with filetype=image and warms the base64 cache', async () => {
    const result = await FileUploadService.uploadImage(fakePngFile());

    expect(result).toEqual({
      url: '/api/file/abc.png',
      originalFilename: 'photo.png',
      type: 'image',
    });

    // Verify the request shape: POST to upload route with image filetype
    // and the file MIME type, sending FormData (not a base64 text body).
    expect(lastXhr).not.toBeNull();
    expect(lastXhr!.open).toHaveBeenCalledWith(
      'POST',
      '/api/file/upload?filename=photo.png&filetype=image&mime=image%2Fpng',
    );
    expect(lastXhr!._body).toBeInstanceOf(FormData);

    // Cache was warmed with the upload's URL and the readFileAsDataURL output.
    expect(cacheImageBase64Mock).toHaveBeenCalledTimes(1);
    expect(cacheImageBase64Mock).toHaveBeenCalledWith(
      '/api/file/abc.png',
      STUB_DATA_URL,
    );
  });

  it('rejects when the upload fails and does not warm the cache', async () => {
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest =
      function (this: unknown) {
        lastXhr = makeFakeXhr({ succeed: false });
        return lastXhr;
      } as unknown as typeof XMLHttpRequest;

    await expect(FileUploadService.uploadImage(fakePngFile())).rejects.toThrow(
      /photo\.png/,
    );

    expect(cacheImageBase64Mock).not.toHaveBeenCalled();
  });

  it('still resolves the upload when readFileAsDataURL fails (cache is best-effort)', async () => {
    readFileSpy.mockRejectedValueOnce(new Error('reader boom'));

    const result = await FileUploadService.uploadImage(fakePngFile());

    expect(result.url).toBe('/api/file/abc.png');
    expect(cacheImageBase64Mock).not.toHaveBeenCalled();
  });
});
