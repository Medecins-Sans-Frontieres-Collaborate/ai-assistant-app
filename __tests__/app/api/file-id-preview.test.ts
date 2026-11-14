import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { renderFilePagePreview } from '@/lib/utils/server/file/filePreview';

import { parseJsonResponse } from './helpers';

import { GET } from '@/app/api/file/[id]/preview/route';
import { auth } from '@/auth';
import { PAGE_PREVIEW_MAX_BYTES } from '@/lib/constants/filePreview';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
// The converters are exercised for real in filePreview.test.ts; here the
// route's own decisions are under test.
vi.mock('@/lib/utils/server/file/filePreview', () => ({
  renderFilePagePreview: vi.fn(),
}));

const HASH = 'a'.repeat(64);
const PREVIEW = { pages: ['data:image/png;base64,AAAA'], totalPages: 1 };

describe('/api/file/[id]/preview', () => {
  const blobClient = { get: vi.fn() };

  const call = (id: string) =>
    GET(new NextRequest(`http://localhost:3000/api/file/${id}/preview`), {
      params: Promise.resolve({ id }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as any);
    vi.mocked(getUserIdFromSession).mockReturnValue('user-1');
    vi.mocked(createBlobStorageClient).mockReturnValue(blobClient as any);
    blobClient.get.mockResolvedValue(Buffer.from('document bytes'));
    vi.mocked(renderFilePagePreview).mockResolvedValue(PREVIEW);
  });

  it("returns the rendered pages of the caller's own document", async () => {
    const response = await call(`${HASH}.pptx`);

    expect(response.status).toBe(200);
    expect((await parseJsonResponse(response)).data).toEqual(PREVIEW);
    expect(blobClient.get).toHaveBeenCalledWith(
      `user-1/uploads/files/${HASH}.pptx`,
      'blob',
    );
    expect(vi.mocked(renderFilePagePreview).mock.calls[0][1]).toBe('pptx');
    expect(response.headers.get('Cache-Control')).toContain('private');
  });

  it.each([
    ['a path outside the store', '..%2F..%2Fetc%2Fpasswd.docx'],
    ['an id that is not a hash', 'report.docx'],
    ['two extensions', `${HASH}.docx.exe`],
  ])('rejects %s without reading storage', async (_label, id) => {
    const response = await call(decodeURIComponent(id));

    expect(response.status).toBe(400);
    expect(blobClient.get).not.toHaveBeenCalled();
  });

  it.each(['png', 'csv', 'txt', 'zip'])(
    'refuses a .%s file, which has no page preview',
    async (extension) => {
      const response = await call(`${HASH}.${extension}`);

      expect(response.status).toBe(400);
      expect(renderFilePagePreview).not.toHaveBeenCalled();
    },
  );

  it('requires a signed-in user', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const response = await call(`${HASH}.docx`);

    expect(response.status).toBe(401);
    expect(blobClient.get).not.toHaveBeenCalled();
  });

  it('answers 404 for a file the user does not have', async () => {
    blobClient.get.mockRejectedValue(
      Object.assign(new Error('BlobNotFound'), {
        statusCode: 404,
        code: 'BlobNotFound',
      }),
    );

    expect((await call(`${HASH}.docx`)).status).toBe(404);
  });

  it('converts a file at the size limit and refuses one just over it', async () => {
    blobClient.get.mockResolvedValue(Buffer.alloc(PAGE_PREVIEW_MAX_BYTES));
    expect((await call(`${HASH}.docx`)).status).toBe(200);

    blobClient.get.mockResolvedValue(Buffer.alloc(PAGE_PREVIEW_MAX_BYTES + 1));
    const tooLarge = await call(`${HASH}.docx`);
    expect(tooLarge.status).toBe(400);
    expect(renderFilePagePreview).toHaveBeenCalledTimes(1);
  });

  it('reports a failed conversion without leaking its details', async () => {
    vi.mocked(renderFilePagePreview).mockRejectedValue(
      new Error('LibreOffice did not produce /tmp/preview-x/input.pdf'),
    );

    const response = await call(`${HASH}.docx`);

    expect(response.status).toBe(500);
    expect(JSON.stringify(await parseJsonResponse(response))).not.toContain(
      '/tmp',
    );
  });
});
