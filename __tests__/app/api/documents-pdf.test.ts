import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import { getRenderService } from '@/lib/services/documents/render/renderService';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  DOCUMENT_PDF_MAX_BYTES,
  DocumentSource,
  documentPdfUrl,
} from '@/lib/utils/shared/documents/documentSource';

import { GET } from '@/app/api/documents/pdf/route';
import { auth } from '@/auth';
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/documents/pdf: any of the person's documents (THE DOCUMENT
 * SOURCE) as a PDF, laid out through the render service. The conversion is
 * a stand-in here (the real one is tested in deckFormat.test.ts); what is
 * tested is what the route allows, reads and asks for.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: vi.fn(),
}));
const translations = vi.hoisted(() => ({ get: vi.fn(), blobExists: vi.fn() }));
vi.mock('@/lib/utils/server/blob/blob', () => ({
  BlobProperty: { BLOB: 'blob' },
  // The translation store: a constructor returning the stand-in.
  AzureBlobStorage: vi.fn(function () {
    return translations;
  }),
}));
vi.mock('@/lib/services/documents/render/renderService', () => ({
  getRenderService: vi.fn(),
}));
vi.mock('@/lib/utils/app/env', () => ({ getEnvVariable: vi.fn(() => 'x') }));

const HASH = 'b'.repeat(64);
const JOB = '0f8e4c1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b';

describe('/api/documents/pdf', () => {
  const blobClient = { get: vi.fn() };
  const convert = vi.fn();

  const call = (source: DocumentSource | string) =>
    GET(
      new NextRequest(
        `http://localhost:3000${typeof source === 'string' ? source : documentPdfUrl(source)}`,
      ),
    );
  const upload = (type: string, id = `${HASH}.${type}`) => ({
    kind: 'upload',
    id,
    type,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
    vi.mocked(getUserIdFromSession).mockReturnValue('user-1');
    vi.mocked(createBlobStorageClient).mockReturnValue(blobClient as never);
    vi.mocked(getRenderService).mockReturnValue({ convert } as never);
    blobClient.get.mockResolvedValue(Buffer.from('PK deck bytes'));
    translations.blobExists.mockResolvedValue(true);
    translations.get.mockResolvedValue(Buffer.from('PK docx bytes'));
    convert.mockImplementation(async (request: { outputDir: string }) => {
      await fs.promises.mkdir(request.outputDir, { recursive: true });
      const out = path.join(request.outputDir, 'out.pdf');
      await fs.promises.writeFile(out, '%PDF-laid-out');
      return out;
    });
  });

  it('lays out the person’s own deck with hidden slides kept', async () => {
    const response = await call(upload('pptm'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(await response.text()).toBe('%PDF-laid-out');
    expect(blobClient.get).toHaveBeenCalledWith(
      `user-1/uploads/files/${HASH}.pptm`,
      'blob',
    );
    const [request] = convert.mock.calls[0];
    // Interactive: a person is waiting to see it.
    expect(request).toMatchObject({ type: 'pptm', lane: 'interactive' });
    expect(request.convertTo).toContain('ExportHiddenSlides');
    // The work directory is gone afterwards.
    expect(fs.existsSync(path.dirname(request.inputPath))).toBe(false);
  });

  it('lays out a text document with the Writer export', async () => {
    await call(upload('docx'));
    expect(convert.mock.calls[0][0]).toMatchObject({ type: 'docx' });
    expect(convert.mock.calls[0][0].convertTo).toMatch(
      /^pdf:writer_pdf_Export/,
    );
  });

  it('serves a PDF as it is, without converting', async () => {
    blobClient.get.mockResolvedValue(Buffer.from('%PDF-own'));
    const response = await call(upload('pdf'));
    expect(await response.text()).toBe('%PDF-own');
    expect(convert).not.toHaveBeenCalled();
  });

  it('reads a document translation’s output and its original from their store', async () => {
    await call({ kind: 'translation', id: JOB, type: 'docx' });
    await call({ kind: 'translation-original', id: JOB, type: 'docx' });
    expect(translations.get.mock.calls.map(([blob]) => blob)).toEqual([
      `user-1/translations/${JOB}.docx`,
      `user-1/translations/${JOB}_original.docx`,
    ]);
  });

  it('finds nothing for an output that is gone, or a job id that is not one', async () => {
    translations.blobExists.mockResolvedValue(false);
    expect(
      (await call({ kind: 'translation', id: JOB, type: 'docx' })).status,
    ).toBe(404);
    translations.blobExists.mockResolvedValue(true);
    expect(
      (await call({ kind: 'translation', id: 'not_a_job', type: 'docx' }))
        .status,
    ).toBe(404);
  });

  it('finds nothing for an upload whose id does not end in its type', async () => {
    expect((await call(upload('pptx', `${HASH}.docx`))).status).toBe(404);
    expect(blobClient.get).not.toHaveBeenCalled();
  });

  it.each([
    ['a type without pages', upload('txt')],
    [
      'an unknown kind',
      { kind: 'elsewhere', id: `${HASH}.pptx`, type: 'pptx' },
    ],
  ])('refuses %s', async (_label, source) => {
    expect((await call(source)).status).toBe(400);
    expect(blobClient.get).not.toHaveBeenCalled();
  });

  it.each([
    '/api/documents/pdf?kind=upload&type=pptx',
    `/api/documents/pdf?kind=upload&id=..%2F..%2Fother%2F${HASH}.pptx&type=pptx`,
    `/api/documents/pdf?kind=Upload&id=${HASH}.pptx&type=pptx`,
  ])('refuses the malformed source %s', async (url) => {
    const response = await call(url);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('INVALID_SOURCE');
    expect(blobClient.get).not.toHaveBeenCalled();
  });

  it('needs a signed-in person', async () => {
    vi.mocked(auth).mockResolvedValue(null);
    expect((await call(upload('pptx'))).status).toBe(401);
  });

  it('refuses a document past the size limit, and takes one at it', async () => {
    blobClient.get.mockResolvedValue(Buffer.alloc(DOCUMENT_PDF_MAX_BYTES + 1));
    expect((await call(upload('pptx'))).status).toBe(400);
    blobClient.get.mockResolvedValue(Buffer.alloc(DOCUMENT_PDF_MAX_BYTES));
    expect((await call(upload('pptx'))).status).toBe(200);
  });

  it('answers 503 with Retry-After when the render queue is full', async () => {
    convert.mockRejectedValue(new RenderBusyError(50));
    const response = await call(upload('pptx'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });
});
