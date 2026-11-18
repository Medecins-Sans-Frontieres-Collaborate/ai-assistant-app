import { TranslationJob } from '@/lib/services/documentTranslation/translationJobStore';
import { MAX_PAGES_PER_READ } from '@/lib/services/documentTranslation/translationPages';

import { GET, PUT } from '@/app/api/document-translation/pages/[jobId]/route';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { GET as EXPORT } from '@/app/api/document-translation/export/[jobId]/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockExtract = vi.hoisted(() => vi.fn());
const mockRenderDocx = vi.hoisted(() => vi.fn());
/** The user's blob container, shared by every storage instance in a test. */
const blobs = vi.hoisted(() => new Map<string, string>());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/utils/app/env', () => ({
  getEnvVariable: () => 'test-storage',
}));
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  extractPdfPageTexts: mockExtract,
  removeTempDir: vi.fn(),
}));
vi.mock(
  '@/lib/services/documentTranslation/translationDocx',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    renderTranslationDocx: mockRenderDocx,
  }),
);
vi.mock('@/lib/utils/server/blob/blob', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    AzureBlobStorage: class {
      blobExists = async (path: string) => blobs.has(path);
      get = async (path: string) => {
        if (!blobs.has(path)) throw new Error('BlobNotFound');
        return Buffer.from(blobs.get(path)!);
      };
      upload = async (path: string, content: string | Buffer) => {
        blobs.set(path, content.toString());
        return path;
      };
    },
  };
});

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'test-user-id';
const PREFIX = `${USER_ID}/translations`;
/** More pages than one read returns, so the window cap is exercised. */
const PAGE_COUNT = MAX_PAGES_PER_READ + 5;

function seedJob(overrides: Partial<TranslationJob> = {}) {
  const job: TranslationJob = {
    jobId: JOB_ID,
    userId: USER_ID,
    operationId: 'op-123',
    filename: 'guide.pdf',
    translatedFilename: 'guide_es.pdf',
    ext: 'pdf',
    targetLanguage: 'es',
    createdAt: Date.now(),
    ...overrides,
  };
  blobs.set(`${PREFIX}/jobs/${JOB_ID}.json`, JSON.stringify(job));
  blobs.set(`${PREFIX}/${JOB_ID}_original.${job.ext}`, 'original');
  blobs.set(`${PREFIX}/${JOB_ID}.${job.ext}`, 'translated');
}

const routeParams = { params: Promise.resolve({ jobId: JOB_ID }) };
const getPages = (query = '') =>
  GET(
    createMockRequest({
      url: `http://localhost:3000/api/document-translation/pages/${JOB_ID}${query}`,
    }),
    routeParams,
  );
const putCorrection = (body: unknown) =>
  PUT(createMockRequest({ method: 'PUT', body }), routeParams);
const exportDocx = (query = '') =>
  EXPORT(
    createMockRequest({
      url: `http://localhost:3000/api/document-translation/export/${JOB_ID}${query}`,
    }),
    routeParams,
  );

beforeEach(() => {
  vi.clearAllMocks();
  blobs.clear();
  mockAuth.mockResolvedValue(createMockSession(USER_ID));
  mockExtract.mockImplementation(async (filePath: string) =>
    Array.from({ length: PAGE_COUNT }, (_, index) =>
      filePath.includes('source.')
        ? `source ${index + 1}`
        : `destino ${index + 1}`,
    ),
  );
  mockRenderDocx.mockResolvedValue(Buffer.from('docx-bytes'));
});

describe('GET /api/document-translation/pages/[jobId]', () => {
  it('401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await getPages()).status).toBe(401);
  });

  it('404 when the job does not exist or belongs to someone else', async () => {
    expect((await getPages()).status).toBe(404);
    seedJob({ userId: 'other-user' });
    expect((await getPages()).status).toBe(404);
  });

  it('returns the requested window with source and translation', async () => {
    seedJob();
    const json = await parseJsonResponse(await getPages('?from=2&to=3'));
    expect(json.data).toMatchObject({
      pageCount: PAGE_COUNT,
      pagesAligned: true,
      from: 2,
      to: 3,
      correctedPages: [],
    });
    expect(json.data.pages).toEqual([
      { page: 2, source: 'source 2', translation: 'destino 2' },
      { page: 3, source: 'source 3', translation: 'destino 3' },
    ]);
  });

  it('caps a window at MAX_PAGES_PER_READ pages', async () => {
    seedJob();
    const json = await parseJsonResponse(
      await getPages(`?from=1&to=${PAGE_COUNT}`),
    );
    expect(json.data.to).toBe(MAX_PAGES_PER_READ);
    expect(json.data.pages).toHaveLength(MAX_PAGES_PER_READ);
  });

  it('clamps a window that runs past the last page', async () => {
    seedJob();
    const json = await parseJsonResponse(
      await getPages(`?from=${PAGE_COUNT}&to=${PAGE_COUNT + 10}`),
    );
    expect(json.data.to).toBe(PAGE_COUNT);
    expect(json.data.pages.map((p: { page: number }) => p.page)).toEqual([
      PAGE_COUNT,
    ]);
  });

  it('400 for a reversed or zero range', async () => {
    seedJob();
    expect((await getPages('?from=5&to=2')).status).toBe(400);
    expect((await getPages('?from=0&to=2')).status).toBe(400);
  });

  it('422 for a format without a page view', async () => {
    seedJob({ ext: 'docx' });
    const response = await getPages();
    expect(response.status).toBe(422);
    expect((await parseJsonResponse(response)).code).toBe('PAGES_UNSUPPORTED');
  });

  it('404 with a specific code when the translated file has expired', async () => {
    seedJob();
    blobs.delete(`${PREFIX}/${JOB_ID}.pdf`);
    const response = await getPages();
    expect(response.status).toBe(404);
    expect((await parseJsonResponse(response)).code).toBe(
      'TRANSLATION_MISSING',
    );
  });
});

describe('PUT /api/document-translation/pages/[jobId]', () => {
  it('saves a correction that the next read returns', async () => {
    seedJob();
    const saved = await parseJsonResponse(
      await putCorrection({ page: 2, text: '1 comp.' }),
    );
    expect(saved.data.correctedPages).toEqual([2]);

    const json = await parseJsonResponse(await getPages('?from=2&to=2'));
    expect(json.data.pages[0]).toMatchObject({
      translation: 'destino 2',
      correction: { text: '1 comp.' },
    });
    expect(json.data.correctedPages).toEqual([2]);
  });

  it('removes a correction with text null', async () => {
    seedJob();
    await putCorrection({ page: 2, text: 'x' });
    const cleared = await parseJsonResponse(
      await putCorrection({ page: 2, text: null }),
    );
    expect(cleared.data.correction).toBeNull();
    expect(cleared.data.correctedPages).toEqual([]);
  });

  it('accepts the last page and refuses the page after it', async () => {
    seedJob();
    expect((await putCorrection({ page: PAGE_COUNT, text: 'x' })).status).toBe(
      200,
    );
    expect(
      (await putCorrection({ page: PAGE_COUNT + 1, text: 'x' })).status,
    ).toBe(400);
  });

  it('400 for a malformed body', async () => {
    seedJob();
    expect((await putCorrection({ page: '2', text: 'x' })).status).toBe(400);
    expect((await putCorrection({ page: 2 })).status).toBe(400);
    expect((await putCorrection({ page: 2, text: 5 })).status).toBe(400);
  });

  it('404 for a job owned by someone else, without writing anything', async () => {
    seedJob({ userId: 'other-user' });
    const before = blobs.size;
    expect((await putCorrection({ page: 1, text: 'x' })).status).toBe(404);
    expect(blobs.size).toBe(before);
  });
});

describe('GET /api/document-translation/export/[jobId]', () => {
  it('renders every page, using corrections where they exist', async () => {
    seedJob();
    await putCorrection({ page: 2, text: '1 comp.' });

    const response = await exportDocx();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('wordprocessingml');
    expect(response.headers.get('Content-Disposition')).toContain(
      'guide_es.docx',
    );
    const [pages, options] = mockRenderDocx.mock.calls[0];
    expect(pages).toHaveLength(PAGE_COUNT);
    expect(pages[0]).toEqual({ page: 1, text: 'destino 1' });
    expect(pages[1]).toEqual({ page: 2, text: '1 comp.' });
    expect(options).toMatchObject({ language: 'es', direction: 'ltr' });
  });

  it('exports right-to-left for a right-to-left target language', async () => {
    seedJob({ targetLanguage: 'ar', translatedFilename: 'guide_ar.pdf' });
    await exportDocx();
    expect(mockRenderDocx.mock.calls[0][1]).toMatchObject({
      language: 'ar',
      direction: 'rtl',
    });
  });

  it('400 for an unsupported format', async () => {
    seedJob();
    expect((await exportDocx('?format=odt')).status).toBe(400);
    expect(mockRenderDocx).not.toHaveBeenCalled();
  });

  it('401 without a session and 404 for an unknown job', async () => {
    expect((await exportDocx()).status).toBe(404);
    mockAuth.mockResolvedValue(null);
    expect((await exportDocx()).status).toBe(401);
  });

  it('500 with a specific code when the converter fails', async () => {
    seedJob();
    mockRenderDocx.mockRejectedValue(new Error('pandoc exited 1'));
    const response = await exportDocx();
    expect(response.status).toBe(500);
    expect((await parseJsonResponse(response)).code).toBe('EXPORT_FAILED');
  });
});
