import { NextRequest } from 'next/server';

import {
  deleteTranslationJob,
  getTranslationJobForUser,
} from '@/lib/services/documentTranslation/translationJobStore';

import { createMockSession, parseJsonResponse } from './helpers';

import { POST } from '@/app/api/document-translation/translate/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockTranslateDocument = vi.hoisted(() => vi.fn());
const mockSubmitBatch = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockGenerateSasUrl = vi.hoisted(() => vi.fn());

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
vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: class {
    upload = mockUpload;
    generateSasUrl = mockGenerateSasUrl;
  },
}));

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
  let createdJobId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockUpload.mockResolvedValue(undefined);
    mockGenerateSasUrl.mockImplementation(
      async (path: string, _h: number, perms = 'r') =>
        `https://blob.example.com/${path}?sig=${perms}-sas`,
    );
    mockSubmitBatch.mockResolvedValue('op-abc-123');
  });

  afterEach(() => {
    if (createdJobId) deleteTranslationJob(createdJobId);
    createdJobId = undefined;
  });

  it('routes PDFs through the batch path and returns a 202 pending reference', async () => {
    const res = await POST(translateRequest('report.pdf'));
    const json = await parseJsonResponse(res);
    if (res.status !== 202)
      console.log('DEBUG:', res.status, JSON.stringify(json));

    expect(res.status).toBe(202);
    expect(json.data.async).toBe(true);
    expect(json.data.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.data.originalFilename).toBe('report.pdf');
    expect(json.data.fileExtension).toBe('pdf');
    createdJobId = json.data.jobId;

    // The sync API was never called for a PDF.
    expect(mockTranslateDocument).not.toHaveBeenCalled();

    // Batch submitted with read-SAS source and create+write-SAS target on
    // the STANDARD translated-blob path (existing download route serves it).
    const batchArgs = mockSubmitBatch.mock.calls[0][0];
    expect(batchArgs.sourceSasUrl).toContain(`${createdJobId}_original.pdf`);
    expect(batchArgs.sourceSasUrl).toContain('sig=r-sas');
    expect(batchArgs.targetSasUrl).toContain(`${createdJobId}.pdf`);
    expect(batchArgs.targetSasUrl).toContain('sig=cw-sas');
    expect(batchArgs.targetLanguage).toBe('fr');

    // Job record persisted for the status route, scoped to the user.
    const job = getTranslationJobForUser(createdJobId!, 'test-user-id');
    expect(job).toMatchObject({ operationId: 'op-abc-123', ext: 'pdf' });

    // Only the ORIGINAL was uploaded — the target is written by Azure.
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][0]).toContain('_original.pdf');
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
