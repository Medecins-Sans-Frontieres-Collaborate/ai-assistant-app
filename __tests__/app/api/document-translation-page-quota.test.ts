import { NextRequest, NextResponse } from 'next/server';

import { createMockSession } from './helpers';

import { POST } from '@/app/api/document-translation/translate/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockGuardLimit = vi.hoisted(() => vi.fn());
const mockCountPdfPages = vi.hoisted(() => vi.fn());
const mockSubmitBatch = vi.hoisted(() => vi.fn());
const mockTranslateDocument = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/utils/app/env', () => ({
  getEnvVariable: () => 'test-storage',
}));
vi.mock('@/lib/utils/server/observability', () => ({
  createApiLoggingContext: () => ({
    logger: { logTranslationSuccess: vi.fn(), logTranslationError: vi.fn() },
    timer: { elapsed: () => 1 },
    getErrorMessage: (e: unknown) => String(e),
  }),
}));
vi.mock('@/lib/services/limits/routeGuard', () => ({
  guardLimit: mockGuardLimit,
}));
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  countPdfPages: mockCountPdfPages,
}));
vi.mock(
  '@/lib/services/documentTranslation/documentTranslationService',
  () => ({
    DocumentTranslationService: class {
      translateDocument = mockTranslateDocument;
      submitBatchTranslation = mockSubmitBatch;
    },
  }),
);
vi.mock('@/lib/utils/server/blob/blob', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AzureBlobStorage: class {
    upload = mockUpload;
    generateContainerScopedSasUrl = async () => 'https://staging.example/sas';
  },
}));

const JOBS_KEY = 'feature.translation.jobsPerDay';
const PAGES_KEY = 'feature.translation.pagesPerDay';
const PAGE_COUNT = 409;

const jobsRollback = vi.fn(async () => undefined);
const pagesRollback = vi.fn(async () => undefined);

function translateRequest(filename: string): NextRequest {
  const formData = new FormData();
  formData.append(
    'document',
    new File([new Uint8Array([1, 2, 3])], filename, {
      type: filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
    }),
  );
  formData.append('targetLanguage', 'es');
  return new NextRequest(
    'http://localhost:3000/api/document-translation/translate',
    { method: 'POST', body: formData },
  );
}

/** The amount each limit key was charged, in call order. */
const charges = () =>
  mockGuardLimit.mock.calls.map(([, key, options]) => [
    key,
    options?.amount ?? 1,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(createMockSession());
  mockUpload.mockResolvedValue(undefined);
  mockSubmitBatch.mockResolvedValue('op-1');
  mockTranslateDocument.mockResolvedValue(Buffer.from('translated'));
  mockCountPdfPages.mockResolvedValue(PAGE_COUNT);
  mockGuardLimit.mockImplementation(async (_session, key: string) => ({
    allowed: true,
    rollback: key === PAGES_KEY ? pagesRollback : jobsRollback,
  }));
});

describe('POST /api/document-translation/translate page allowance', () => {
  it('charges a PDF one job and its page count', async () => {
    const response = await POST(translateRequest('manual.pdf'));

    expect(response.status).toBe(202);
    expect(charges()).toEqual([
      [JOBS_KEY, 1],
      [PAGES_KEY, PAGE_COUNT],
    ]);
    expect(jobsRollback).not.toHaveBeenCalled();
    expect(pagesRollback).not.toHaveBeenCalled();
  });

  it('refuses a PDF over the page allowance, starts nothing, and returns the job reservation', async () => {
    mockGuardLimit.mockImplementation(async (_session, key: string) =>
      key === PAGES_KEY
        ? {
            allowed: false,
            response: NextResponse.json({ code: 'QUOTA' }, { status: 403 }),
          }
        : { allowed: true, rollback: jobsRollback },
    );

    const response = await POST(translateRequest('manual.pdf'));

    expect(response.status).toBe(403);
    expect(mockSubmitBatch).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(jobsRollback).toHaveBeenCalledTimes(1);
  });

  it('returns both reservations when the submission fails', async () => {
    mockSubmitBatch.mockRejectedValue(new Error('translator unavailable'));

    const response = await POST(translateRequest('manual.pdf'));

    expect(response.status).toBe(500);
    expect(jobsRollback).toHaveBeenCalledTimes(1);
    expect(pagesRollback).toHaveBeenCalledTimes(1);
  });

  it('does not charge pages when the page count cannot be read', async () => {
    mockCountPdfPages.mockRejectedValue(new Error('not a PDF'));

    const response = await POST(translateRequest('manual.pdf'));

    expect(response.status).toBe(202);
    expect(charges()).toEqual([[JOBS_KEY, 1]]);
  });

  it('does not count pages for formats on the synchronous path', async () => {
    const response = await POST(translateRequest('notes.txt'));

    expect(response.status).toBe(200);
    expect(mockCountPdfPages).not.toHaveBeenCalled();
    expect(charges()).toEqual([[JOBS_KEY, 1]]);
  });
});
