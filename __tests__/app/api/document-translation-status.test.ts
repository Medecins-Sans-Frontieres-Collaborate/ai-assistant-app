import {
  createTranslationJob,
  deleteTranslationJob,
} from '@/lib/services/documentTranslation/translationJobStore';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { GET } from '@/app/api/document-translation/status/[jobId]/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockGetBatchStatus = vi.hoisted(() => vi.fn());
const mockBlobExists = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/utils/app/env', () => ({
  getEnvVariable: () => 'test-storage',
}));
vi.mock(
  '@/lib/services/documentTranslation/documentTranslationService',
  () => ({
    DocumentTranslationService: class {
      getBatchTranslationStatus = mockGetBatchStatus;
    },
  }),
);
vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: class {
    blobExists = mockBlobExists;
  },
}));

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'test-user-id';

function seedJob(userId = USER_ID) {
  createTranslationJob({
    jobId: JOB_ID,
    userId,
    operationId: 'op-123',
    filename: 'report.pdf',
    translatedFilename: 'report_fr.pdf',
    ext: 'pdf',
    targetLanguage: 'fr',
    createdAt: Date.now(),
  });
}

const call = () =>
  GET(createMockRequest({ method: 'GET' }), {
    params: Promise.resolve({ jobId: JOB_ID }),
  });

describe('GET /api/document-translation/status/[jobId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession(USER_ID));
    mockBlobExists.mockResolvedValue(true);
  });

  afterEach(() => {
    deleteTranslationJob(JOB_ID);
  });

  it('401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it('404 for jobs owned by someone else (no enumeration)', async () => {
    seedJob('other-user');
    expect((await call()).status).toBe(404);
  });

  it('reports Running while Azure is processing', async () => {
    seedJob();
    mockGetBatchStatus.mockResolvedValue({
      status: 'Running',
      azureStatus: 'Running',
    });

    const json = await parseJsonResponse(await call());
    expect(json.data.status).toBe('Running');
  });

  it('reports Succeeded with the full reference once the blob exists', async () => {
    seedJob();
    mockGetBatchStatus.mockResolvedValue({
      status: 'Succeeded',
      azureStatus: 'Succeeded',
    });

    const json = await parseJsonResponse(await call());

    expect(json.data.status).toBe('Succeeded');
    expect(json.data.reference).toMatchObject({
      jobId: JOB_ID,
      originalFilename: 'report.pdf',
      translatedFilename: 'report_fr.pdf',
      targetLanguage: 'fr',
      fileExtension: 'pdf',
      blobPath: `${USER_ID}/translations/${JOB_ID}.pdf`,
    });
    expect(json.data.reference.originalFileUrl).toContain(
      `/api/document-translation/content/${JOB_ID}`,
    );
  });

  it('keeps polling (Running) when Azure says Succeeded but the blob is not visible yet', async () => {
    seedJob();
    mockGetBatchStatus.mockResolvedValue({
      status: 'Succeeded',
      azureStatus: 'Succeeded',
    });
    mockBlobExists.mockResolvedValue(false);

    const json = await parseJsonResponse(await call());
    expect(json.data.status).toBe('Running');
  });

  it('reports Failed with the Azure error', async () => {
    seedJob();
    mockGetBatchStatus.mockResolvedValue({
      status: 'Failed',
      azureStatus: 'ValidationFailed',
      error: 'Document format is not supported',
    });

    const json = await parseJsonResponse(await call());
    expect(json.data.status).toBe('Failed');
    expect(json.data.error).toBe('Document format is not supported');
  });

  it('502 (retryable) when the Azure poll itself errors', async () => {
    seedJob();
    mockGetBatchStatus.mockRejectedValue(new Error('network'));

    expect((await call()).status).toBe(502);
  });
});
