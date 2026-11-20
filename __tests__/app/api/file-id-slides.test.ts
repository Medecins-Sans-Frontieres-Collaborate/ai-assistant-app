import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { RenderBusyError } from '@/lib/services/documents/render/renderQueue';
import { getRenderService } from '@/lib/services/documents/render/renderService';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { NATIVE_DECK_MAX_BYTES } from '@/lib/utils/shared/translation/nativeFormats';

import { GET } from '@/app/api/file/[id]/slides/route';
import { auth } from '@/auth';
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/file/[id]/slides: an uploaded presentation as a PDF of its
 * slides, laid out through the render service. The conversion is a stand-in
 * here (the real one is tested in deckFormat.test.ts); what is tested is
 * what the route allows and asks for.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: vi.fn(),
}));
vi.mock('@/lib/utils/server/blob/blob', () => ({
  BlobProperty: { BLOB: 'blob' },
}));
vi.mock('@/lib/services/documents/render/renderService', () => ({
  getRenderService: vi.fn(),
}));

const HASH = 'b'.repeat(64);

describe('/api/file/[id]/slides', () => {
  const blobClient = { get: vi.fn() };
  const convert = vi.fn();

  const call = (id: string) =>
    GET(new NextRequest(`http://localhost:3000/api/file/${id}/slides`), {
      params: Promise.resolve({ id }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
    vi.mocked(getUserIdFromSession).mockReturnValue('user-1');
    vi.mocked(createBlobStorageClient).mockReturnValue(blobClient as never);
    vi.mocked(getRenderService).mockReturnValue({ convert } as never);
    blobClient.get.mockResolvedValue(Buffer.from('PK deck bytes'));
    convert.mockImplementation(async (request: { outputDir: string }) => {
      await fs.promises.mkdir(request.outputDir, { recursive: true });
      const out = path.join(request.outputDir, 'deck.pdf');
      await fs.promises.writeFile(out, '%PDF-slides');
      return out;
    });
  });

  it('serves the person’s own deck as a PDF with hidden slides kept', async () => {
    const response = await call(`${HASH}.pptm`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(await response.text()).toBe('%PDF-slides');
    expect(blobClient.get).toHaveBeenCalledWith(
      `user-1/uploads/files/${HASH}.pptm`,
      'blob',
    );
    const [request] = convert.mock.calls[0];
    // Interactive: a person is waiting on the setup.
    expect(request).toMatchObject({ type: 'pptm', lane: 'interactive' });
    expect(request.convertTo).toContain('ExportHiddenSlides');
    // The work directory is gone afterwards.
    expect(fs.existsSync(path.dirname(request.inputPath))).toBe(false);
  });

  it('takes a .ppt as its own type', async () => {
    await call(`${HASH}.ppt`);
    expect(convert.mock.calls[0][0].type).toBe('ppt');
  });

  it.each([`${HASH}.pdf`, `${HASH}.docx`, `${HASH}.odp`, 'report.pptx'])(
    'refuses %s without reading storage',
    async (id) => {
      expect((await call(id)).status).toBe(400);
      expect(blobClient.get).not.toHaveBeenCalled();
    },
  );

  it('needs a signed-in person', async () => {
    vi.mocked(auth).mockResolvedValue(null);
    expect((await call(`${HASH}.pptx`)).status).toBe(401);
  });

  it('refuses a deck past the size limit, and takes one at it', async () => {
    blobClient.get.mockResolvedValue(Buffer.alloc(NATIVE_DECK_MAX_BYTES + 1));
    expect((await call(`${HASH}.pptx`)).status).toBe(400);
    blobClient.get.mockResolvedValue(Buffer.alloc(NATIVE_DECK_MAX_BYTES));
    expect((await call(`${HASH}.pptx`)).status).toBe(200);
  });

  it('answers 503 with Retry-After when the render queue is full', async () => {
    convert.mockRejectedValue(new RenderBusyError(50));
    const response = await call(`${HASH}.pptx`);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });
});
