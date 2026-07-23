import { NextRequest } from 'next/server';

import { createMockSession, parseJsonResponse } from './helpers';

import { POST } from '@/app/api/document-translation/translate/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockTranslateDocument = vi.hoisted(() => vi.fn());
const mockSubmitBatch = vi.hoisted(() => vi.fn());
// All storage calls are tagged with the CONTAINER of the instance they were
// made on: the user-data container ('test-storage', from the getEnvVariable
// mock) vs the translation staging container ('doc-translation-staging').
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
vi.mock(
  '@/lib/services/documentTranslation/documentTranslationService',
  () => ({
    DocumentTranslationService: class {
      translateDocument = mockTranslateDocument;
      submitBatchTranslation = mockSubmitBatch;
    },
  }),
);
vi.mock('@/lib/utils/server/blob/blob', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    AzureBlobStorage: class {
      constructor(
        _name: string,
        private container: string,
      ) {}
      upload = (path: string, content: unknown, opts: unknown) =>
        mockUpload(this.container, path, content, opts);
      generateContainerScopedSasUrl = async (
        path: string,
        _hours: number,
        perms: string,
      ) =>
        `https://staging.blob.example.com/${this.container}/${path}?sig=${perms}-sas`;
    },
  };
});

const USER_CONTAINER = 'test-storage';
const STAGING_CONTAINER = 'doc-translation-staging';

function translateRequest(
  filename: string,
  targetLanguage = 'fr',
): NextRequest {
  const formData = new FormData();
  formData.append(
    'document',
    new File([new Uint8Array([1, 2, 3])], filename, {
      type: filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
    }),
  );
  formData.append('targetLanguage', targetLanguage);
  return new NextRequest(
    'http://localhost:3000/api/document-translation/translate',
    {
      method: 'POST',
      body: formData,
    },
  );
}

describe('POST /api/document-translation/translate (async PDF branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockUpload.mockResolvedValue(undefined);
    mockSubmitBatch.mockResolvedValue('op-abc-123');
  });

  it('routes PDFs through the staging batch path and returns a 202 pending reference', async () => {
    const res = await POST(translateRequest('report.pdf'));
    const json = await parseJsonResponse(res);
    if (res.status !== 202)
      console.log('DEBUG:', res.status, JSON.stringify(json));

    expect(res.status).toBe(202);
    expect(json.data.async).toBe(true);
    expect(json.data.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.data.originalFilename).toBe('report.pdf');
    expect(json.data.fileExtension).toBe('pdf');
    const jobId = json.data.jobId;

    // The sync API was never called for a PDF.
    expect(mockTranslateDocument).not.toHaveBeenCalled();

    // Batch submitted with container-scoped SAS URLs pointing at the
    // STAGING container — never at user-data storage. Source read+list
    // ('rl'), target write+list ('wl').
    const batchArgs = mockSubmitBatch.mock.calls[0][0];
    expect(batchArgs.sourceUrl).toContain(
      `${STAGING_CONTAINER}/test-user-id/translations/${jobId}_original.pdf`,
    );
    expect(batchArgs.sourceUrl).toContain('sig=rl-sas');
    expect(batchArgs.targetUrl).toContain(
      `${STAGING_CONTAINER}/test-user-id/translations/${jobId}.pdf`,
    );
    expect(batchArgs.targetUrl).toContain('sig=wl-sas');
    expect(batchArgs.targetLanguage).toBe('fr');

    // Uploads: original to USER storage (immediate download), original to
    // STAGING (what the Translator reads), and the job record to USER
    // storage (replica-safe store). The target is written by Azure.
    const uploads = mockUpload.mock.calls.map((c) => [c[0], c[1]]);
    expect(uploads).toHaveLength(3);
    expect(uploads).toContainEqual([
      USER_CONTAINER,
      `test-user-id/translations/${jobId}_original.pdf`,
    ]);
    expect(uploads).toContainEqual([
      STAGING_CONTAINER,
      `test-user-id/translations/${jobId}_original.pdf`,
    ]);
    expect(uploads).toContainEqual([
      USER_CONTAINER,
      `test-user-id/translations/jobs/${jobId}.json`,
    ]);

    // Job record persisted for the status route, scoped to the user.
    const jobRecordCall = mockUpload.mock.calls.find((c) =>
      (c[1] as string).endsWith(`jobs/${jobId}.json`),
    );
    expect(JSON.parse(jobRecordCall![2] as string)).toMatchObject({
      jobId,
      userId: 'test-user-id',
      operationId: 'op-abc-123',
      ext: 'pdf',
    });
  });

  it('keeps non-PDF formats on the synchronous path', async () => {
    mockTranslateDocument.mockResolvedValue(Buffer.from('translated'));

    const res = await POST(translateRequest('notes.txt'));
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(200);
    expect(json.data.async).toBeUndefined();
    expect(json.data.jobId).toBeDefined();
    expect(mockTranslateDocument).toHaveBeenCalled();
    expect(mockSubmitBatch).not.toHaveBeenCalled();
  });

  it('surfaces batch submit failures as TRANSLATION_FAILED', async () => {
    mockSubmitBatch.mockRejectedValue(new Error('Batch quota exceeded'));

    const res = await POST(translateRequest('report.pdf'));
    const json = await parseJsonResponse(res);

    expect(res.status).toBe(500);
    expect(json.code).toBe('TRANSLATION_FAILED');
  });
});
