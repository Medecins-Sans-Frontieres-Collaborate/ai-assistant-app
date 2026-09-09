import { TranslationJob } from '@/lib/services/documentTranslation/translationJobStore';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { GET } from '@/app/api/document-translation/status/[jobId]/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockGetBatchStatus = vi.hoisted(() => vi.fn());
// All storage calls are tagged with the CONTAINER of the instance they were
// made on: user-data ('test-storage') vs staging ('doc-translation-staging').
const mockBlobExists = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockDeleteIfExists = vi.hoisted(() => vi.fn());

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
vi.mock('@/lib/utils/server/blob/blob', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    AzureBlobStorage: class {
      constructor(
        _name: string,
        private container: string,
      ) {}
      blobExists = (path: string) => mockBlobExists(this.container, path);
      get = (path: string, prop?: unknown) =>
        mockGet(this.container, path, prop);
      upload = (path: string, content: unknown, opts: unknown) =>
        mockUpload(this.container, path, content, opts);
      deleteIfExists = (path: string) =>
        mockDeleteIfExists(this.container, path);
    },
  };
});

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'test-user-id';
const USER_CONTAINER = 'test-storage';
const STAGING_CONTAINER = 'doc-translation-staging';
const JOB_RECORD_PATH = `${USER_ID}/translations/jobs/${JOB_ID}.json`;
const TRANSLATED_PATH = `${USER_ID}/translations/${JOB_ID}.pdf`;

/** Job records live in blob storage — seed by stubbing the blob read. */
function seedJob(userId = USER_ID) {
  const job: TranslationJob = {
    jobId: JOB_ID,
    userId,
    operationId: 'op-123',
    filename: 'report.pdf',
    translatedFilename: 'report_fr.pdf',
    ext: 'pdf',
    targetLanguage: 'fr',
    createdAt: Date.now(),
  };
  mockGet.mockImplementation(async (_container: string, path: string) => {
    if (path === JOB_RECORD_PATH) return Buffer.from(JSON.stringify(job));
    throw new Error('BlobNotFound');
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
    mockUpload.mockResolvedValue(undefined);
    mockDeleteIfExists.mockResolvedValue(true);
    // No job record unless a test seeds one.
    mockGet.mockRejectedValue(new Error('BlobNotFound'));
  });

  it('401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it('404 when no job record exists', async () => {
    expect((await call()).status).toBe(404);
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

  it('reports Succeeded with the full reference once the user-storage blob exists', async () => {
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
      blobPath: TRANSLATED_PATH,
    });
    expect(json.data.reference.originalFileUrl).toContain(
      `/api/document-translation/content/${JOB_ID}`,
    );
    // Already copied back — staging untouched this poll.
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('copies the translated blob from staging into user storage on first Succeeded poll', async () => {
    seedJob();
    mockGetBatchStatus.mockResolvedValue({
      status: 'Succeeded',
      azureStatus: 'Succeeded',
    });
    // Not yet in user storage; present in staging.
    mockBlobExists.mockImplementation(
      async (container: string) => container === STAGING_CONTAINER,
    );
    const job = mockGet.getMockImplementation()!;
    mockGet.mockImplementation(async (container: string, path: string) => {
      if (container === STAGING_CONTAINER && path === TRANSLATED_PATH)
        return Buffer.from('TRANSLATED-PDF');
      return job(container, path, undefined);
    });

    const json = await parseJsonResponse(await call());

    expect(json.data.status).toBe('Succeeded');
    // Copy-back: staging → user storage at the standard path.
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [container, path, content] = mockUpload.mock.calls[0];
    expect(container).toBe(USER_CONTAINER);
    expect(path).toBe(TRANSLATED_PATH);
    expect(Buffer.isBuffer(content)).toBe(true);
    // Scratch cleanup issued against staging only.
    const deletedContainers = mockDeleteIfExists.mock.calls.map((c) => c[0]);
    expect(deletedContainers.length).toBeGreaterThan(0);
    expect(new Set(deletedContainers)).toEqual(new Set([STAGING_CONTAINER]));
  });

  it('keeps polling (Running) when Azure says Succeeded but the staging blob is not visible yet', async () => {
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
