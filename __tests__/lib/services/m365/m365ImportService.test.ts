/**
 * importDriveItemToStorage: metadata validation, buffered vs streamed
 * writes, and the local-upload-parity of the returned reference. Graph and
 * blob boundaries are mocked; the service's routing logic is real.
 */
import { NextRequest } from 'next/server';

import {
  M365ImportError,
  importDriveItemToStorage,
} from '@/lib/services/m365/m365ImportService';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
const graphFetchMock = vi.hoisted(() => vi.fn());
const uploadMock = vi.hoisted(() => vi.fn());
const uploadStreamMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return {
    ...actual,
    graphJson: graphJsonMock,
    graphFetch: graphFetchMock,
  };
});

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({
    upload: uploadMock,
    uploadStream: uploadStreamMock,
  }),
}));

const session = { user: { id: 'user-1' } } as never;
const req = new NextRequest('http://localhost/api/m365/import/storage');
const target = { driveId: 'd1', itemId: 'i1' };

// A valid MP3 header (ID3 tag) so the audio signature check passes.
const MP3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);

function meta(overrides: Record<string, unknown> = {}) {
  return {
    name: 'clip.mp3',
    size: MP3_BYTES.length,
    eTag: '"etag-1"',
    webUrl: 'https://contoso.sharepoint.com/clip.mp3',
    file: { mimeType: 'audio/mpeg' },
    '@microsoft.graph.downloadUrl': 'https://download.example/clip',
    ...overrides,
  };
}

function contentResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('importDriveItemToStorage', () => {
  it('rejects folders before downloading anything', async () => {
    graphJsonMock.mockResolvedValue(meta({ folder: {}, file: undefined }));
    await expect(
      importDriveItemToStorage(req, session, target),
    ).rejects.toMatchObject({ code: 'M365_IS_FOLDER' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rejects files over the category cap without downloading', async () => {
    graphJsonMock.mockResolvedValue(meta({ size: 5 * 1024 * 1024 * 1024 }));
    await expect(
      importDriveItemToStorage(req, session, target),
    ).rejects.toMatchObject({ code: 'M365_FILE_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('buffers small files to a content-hashed upload-parity path', async () => {
    graphJsonMock.mockResolvedValue(meta());
    fetchMock.mockResolvedValue(contentResponse(MP3_BYTES));
    uploadMock.mockResolvedValue('https://blob/x');

    const imported = await importDriveItemToStorage(req, session, target);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [blobName] = uploadMock.mock.calls[0];
    expect(blobName).toMatch(/^user-1\/uploads\/files\/[a-f0-9]{64}\.mp3$/);
    expect(imported.uri).toBe(`/api/file/${blobName.split('/').pop()}`);
    expect(imported).toMatchObject({
      name: 'clip.mp3',
      mimeType: 'audio/mpeg',
      category: 'audio',
      eTag: '"etag-1"',
      webUrl: 'https://contoso.sharepoint.com/clip.mp3',
    });
    expect(uploadStreamMock).not.toHaveBeenCalled();
  });

  it('rejects buffered audio whose bytes fail the signature check', async () => {
    graphJsonMock.mockResolvedValue(meta());
    fetchMock.mockResolvedValue(contentResponse(Buffer.alloc(64, 0x20)));
    await expect(
      importDriveItemToStorage(req, session, target),
    ).rejects.toMatchObject({ code: 'M365_INVALID_CONTENT' });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('streams large files under a UUID name and validates leading bytes', async () => {
    const size = 200 * 1024 * 1024;
    graphJsonMock.mockResolvedValue(meta({ size }));
    fetchMock.mockResolvedValue(contentResponse(MP3_BYTES));
    uploadStreamMock.mockResolvedValue('https://blob/x');

    const imported = await importDriveItemToStorage(req, session, target);

    expect(uploadMock).not.toHaveBeenCalled();
    expect(uploadStreamMock).toHaveBeenCalledTimes(1);
    const { blobName, contentStream } = uploadStreamMock.mock.calls[0][0];
    expect(blobName).toMatch(/^user-1\/uploads\/files\/[0-9a-f-]{36}\.mp3$/);
    // Drain the stream to prove the validated generator yields the bytes.
    const chunks: Buffer[] = [];
    for await (const chunk of contentStream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(MP3_BYTES)).toBe(true);
    expect(imported.uri).toBe(`/api/file/${blobName.split('/').pop()}`);
  });

  it('fails a streamed import when the leading bytes are not audio/video', async () => {
    const size = 200 * 1024 * 1024;
    graphJsonMock.mockResolvedValue(meta({ size }));
    fetchMock.mockResolvedValue(contentResponse(Buffer.alloc(64, 0x20)));
    uploadStreamMock.mockImplementation(
      async ({ contentStream }: { contentStream: AsyncIterable<Buffer> }) => {
        for await (const _chunk of contentStream) {
          // drain like the real uploader
        }
        return 'https://blob/x';
      },
    );
    await expect(
      importDriveItemToStorage(req, session, target),
    ).rejects.toMatchObject({ code: 'M365_INVALID_CONTENT' });
  });

  it('falls back to /content when no downloadUrl is present', async () => {
    graphJsonMock.mockResolvedValue(
      meta({ '@microsoft.graph.downloadUrl': undefined }),
    );
    graphFetchMock.mockResolvedValue(contentResponse(MP3_BYTES));
    uploadMock.mockResolvedValue('https://blob/x');

    await importDriveItemToStorage(req, session, target);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(graphFetchMock).toHaveBeenCalledWith(
      req,
      ['Files.ReadWrite.All'],
      '/drives/d1/items/i1/content',
    );
  });

  it('exposes M365ImportError as a named class for route mapping', () => {
    const error = new M365ImportError('nope', 'M365_IS_FOLDER');
    expect(error.name).toBe('M365ImportError');
  });
});
