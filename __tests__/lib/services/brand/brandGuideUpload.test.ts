import { BrandFileError } from '@/lib/services/brand/brandBooks';
import { storeBrandGuideUpload } from '@/lib/services/brand/brandGuideUpload';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A small limit, so both sides of it fit in a test. */
const LIMIT = 16;

vi.mock('@/lib/utils/shared/brand/brandBook', async (original) => ({
  ...(await original<typeof import('@/lib/utils/shared/brand/brandBook')>()),
  BRAND_FILE_MAX_BYTES: { logo: 16, template: 16, source: 16 },
}));

const storeUploadedFile = vi.hoisted(() =>
  vi.fn(async () => '/api/file/' + 'a'.repeat(64) + '.pdf'),
);
vi.mock('@/lib/services/documents/sources/documentSources', () => ({
  storeUploadedFile,
  storedUploadBytes: (data: Buffer) => data,
}));

// What the bounded reader's module and the brand store pull in besides.
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));
vi.mock('@/lib/services/m365/graphApi', () => ({
  M365Error: class extends Error {},
  m365ErrorResponse: vi.fn(),
}));
vi.mock('@/lib/services/backup/server/backupDriveStore', () => ({
  DriveRateLimitError: class extends Error {},
}));

const session = { user: { id: 'u1' } } as never;

/** A PDF-looking body of exactly `bytes` bytes. */
function pdfOf(bytes: number): Buffer {
  return Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(bytes - 5, 0x20)]);
}

function requestOf(body: Buffer, headers: Record<string, string> = {}) {
  return new Request('http://localhost/guide', {
    method: 'POST',
    body: new Uint8Array(body),
    headers,
  });
}

describe('storeBrandGuideUpload', () => {
  beforeEach(() => storeUploadedFile.mockClear());

  it('keeps a guide exactly at the limit as an upload', async () => {
    const result = await storeBrandGuideUpload(
      session,
      requestOf(pdfOf(LIMIT)),
    );
    expect(result).toEqual({
      file: `/api/file/${'a'.repeat(64)}.pdf`,
      bytes: LIMIT,
    });
    expect(storeUploadedFile).toHaveBeenCalledWith(
      session,
      expect.any(Buffer),
      'pdf',
      'application/pdf',
    );
  });

  it('refuses a guide one byte over the limit, naming the limit', async () => {
    await expect(
      storeBrandGuideUpload(session, requestOf(pdfOf(LIMIT + 1))),
    ).rejects.toThrow(/brand guide can be at most/);
    expect(storeUploadedFile).not.toHaveBeenCalled();
  });

  it('refuses on the declared length without reading the body', async () => {
    const request = new Request('http://localhost/guide', {
      method: 'POST',
      headers: { 'content-length': String(LIMIT + 1) },
    });
    await expect(storeBrandGuideUpload(session, request)).rejects.toThrow(
      BrandFileError,
    );
  });

  it('refuses a file that is not a PDF, and an empty one', async () => {
    await expect(
      storeBrandGuideUpload(
        session,
        requestOf(Buffer.from('PK\u0003\u0004zip')),
      ),
    ).rejects.toThrow('A brand guide must be a PDF.');
    const empty = new Request('http://localhost/guide', { method: 'POST' });
    await expect(storeBrandGuideUpload(session, empty)).rejects.toThrow(
      'The brand guide is empty.',
    );
    expect(storeUploadedFile).not.toHaveBeenCalled();
  });
});
