import { NextRequest, NextResponse } from 'next/server';

import { DocumentIntelligenceError } from '@/lib/services/documentIntelligence/client';

import {
  MAX_OCR_PAGES,
  OCR_PAGES_LIMIT_KEY,
} from '@/lib/utils/shared/file/ocr';

import { createMockSession } from './helpers';

import { POST } from '@/app/api/file/ocr/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockGuardLimit = vi.hoisted(() => vi.fn());
const mockCountPdfPages = vi.hoisted(() => vi.fn());
const mockConfigured = vi.hoisted(() => vi.fn());
const mockOcr = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const rollback = vi.fn(async () => undefined);

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/limits/routeGuard', () => ({
  guardLimit: mockGuardLimit,
}));
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  countPdfPages: mockCountPdfPages,
}));
vi.mock(
  '@/lib/services/documentIntelligence/client',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isDocumentIntelligenceConfigured: mockConfigured,
  }),
);
vi.mock('@/lib/services/documentIntelligence/ocrText', () => ({
  ocrPdfToPagedText: mockOcr,
}));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({ get: mockGet, upload: mockUpload }),
}));

// A stored file's id: the content hash plus its extension.
const HASH = 'a'.repeat(64);
const FILE = `${HASH}.pdf`;
const session = createMockSession();
const userId = session.user.id;

const ocrRequest = (body: unknown) =>
  new NextRequest('http://localhost/api/file/ocr', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const run = async (body: unknown = { url: `/api/file/${FILE}` }) => {
  const response = await POST(ocrRequest(body));
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockConfigured.mockReturnValue(true);
  mockGet.mockResolvedValue(Buffer.from('%PDF'));
  mockUpload.mockResolvedValue(undefined);
  mockCountPdfPages.mockResolvedValue(12);
  mockGuardLimit.mockResolvedValue({ allowed: true, rollback });
  mockOcr.mockResolvedValue({
    text: '--- Page 1 ---\nTexto',
    pagesAnalyzed: 12,
  });
});

describe('POST /api/file/ocr', () => {
  it('reads the file, charges its pages, caches and returns the text', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.data).toEqual({
      content: '--- Page 1 ---\nTexto',
      pageCount: 12,
    });
    expect(mockGet.mock.calls[0][0]).toBe(`${userId}/uploads/files/${FILE}`);
    expect(mockGuardLimit).toHaveBeenCalledWith(
      session,
      OCR_PAGES_LIMIT_KEY,
      expect.objectContaining({ amount: 12 }),
    );
    expect(mockUpload.mock.calls[0].slice(0, 2)).toEqual([
      `${userId}/uploads/files/${FILE}.cached.txt`,
      '--- Page 1 ---\nTexto',
    ]);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await run()).status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing url', {}],
    ['a non-string url', { url: 7 }],
    ['invalid JSON', '{'],
  ])('rejects %s', async (_label, body) => {
    expect((await run(body)).status).toBe(400);
    expect(mockOcr).not.toHaveBeenCalled();
  });

  it("refuses another user's blob", async () => {
    const { status } = await run({
      url: `https://store.example/files/someone-else/uploads/files/${FILE}`,
    });
    expect(status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('accepts only PDFs', async () => {
    const { status, body } = await run({ url: `/api/file/${HASH}.docx` });
    expect(status).toBe(400);
    expect(body.code).toBe('OCR_UNSUPPORTED_FORMAT');
  });

  it('says when OCR is not configured, before touching storage', async () => {
    mockConfigured.mockReturnValue(false);
    const { status, body } = await run();
    expect(status).toBe(503);
    expect(body.code).toBe('OCR_NOT_CONFIGURED');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports a missing file', async () => {
    mockGet.mockRejectedValue(
      Object.assign(new Error('BlobNotFound'), { statusCode: 404 }),
    );
    expect((await run()).status).toBe(404);
  });

  it('brackets the page cap, and charges nothing over it', async () => {
    mockCountPdfPages.mockResolvedValue(MAX_OCR_PAGES);
    expect((await run()).status).toBe(200);

    vi.clearAllMocks();
    mockAuth.mockResolvedValue(session);
    mockConfigured.mockReturnValue(true);
    mockGet.mockResolvedValue(Buffer.from('%PDF'));
    mockCountPdfPages.mockResolvedValue(MAX_OCR_PAGES + 1);
    const { status, body } = await run();
    expect(status).toBe(413);
    expect(body.code).toBe('OCR_TOO_MANY_PAGES');
    expect(mockGuardLimit).not.toHaveBeenCalled();
    expect(mockOcr).not.toHaveBeenCalled();
  });

  it('does not analyse a file whose pages cannot be counted', async () => {
    mockCountPdfPages.mockRejectedValue(new Error('not a pdf'));
    expect((await run()).status).toBe(422);
    expect(mockGuardLimit).not.toHaveBeenCalled();
    expect(mockOcr).not.toHaveBeenCalled();
  });

  it('returns the limit response when the allowance is exhausted', async () => {
    mockGuardLimit.mockResolvedValue({
      allowed: false,
      response: NextResponse.json({ error: 'quota' }, { status: 429 }),
    });
    expect((await run()).status).toBe(429);
    expect(mockOcr).not.toHaveBeenCalled();
  });

  it('refunds the pages when OCR finds no text', async () => {
    mockOcr.mockResolvedValue({ text: '', pagesAnalyzed: 12 });
    const { status, body } = await run();
    expect(status).toBe(422);
    expect(body.code).toBe('NO_EXTRACTABLE_TEXT');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('refunds the pages when the service fails', async () => {
    mockOcr.mockRejectedValue(
      new DocumentIntelligenceError('failed', 'failed'),
    );
    const { status, body } = await run();
    expect(status).toBe(502);
    expect(body.code).toBe('OCR_FAILED');
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('refunds the pages when the request is cancelled', async () => {
    mockOcr.mockRejectedValue(
      new DocumentIntelligenceError('Analysis aborted', 'aborted'),
    );
    expect((await run()).status).toBe(499);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('still returns the text when caching it fails', async () => {
    mockUpload.mockRejectedValue(new Error('storage down'));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.data.pageCount).toBe(12);
    expect(rollback).not.toHaveBeenCalled();
  });
});
