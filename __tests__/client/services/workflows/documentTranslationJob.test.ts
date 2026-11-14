import {
  DocumentJobError,
  fetchDocumentJobPages,
  fetchDocumentJobStatus,
  saveDocumentPageCorrection,
  submitDocumentTranslation,
  textVersionUrl,
  translatedFileUrl,
} from '@/client/services/workflows/documentTranslationJob';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();
const ok = (data: unknown, status = 200) =>
  Response.json({ success: true, data }, { status });
const fail = (status: number, error: string, code?: string) =>
  Response.json({ success: false, error, code }, { status });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('submitDocumentTranslation', () => {
  const file = new File(['%PDF'], 'manual.pdf', { type: 'application/pdf' });

  it('posts the file and language and returns the pending job', async () => {
    const pending = { async: true, jobId: 'job-1', fileExtension: 'pdf' };
    fetchMock.mockResolvedValue(ok(pending, 202));
    await expect(submitDocumentTranslation(file, 'es')).resolves.toEqual(
      pending,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/document-translation/translate');
    const form = init?.body as FormData;
    expect(form.get('targetLanguage')).toBe('es');
    expect((form.get('document') as File).name).toBe('manual.pdf');
  });

  it('carries the server code and status on refusal', async () => {
    fetchMock.mockResolvedValue(
      fail(503, 'Not configured', 'SERVICE_NOT_CONFIGURED'),
    );
    const error = await submitDocumentTranslation(file, 'es').catch((e) => e);
    expect(error).toBeInstanceOf(DocumentJobError);
    expect(error).toMatchObject({
      status: 503,
      code: 'SERVICE_NOT_CONFIGURED',
      message: 'Not configured',
    });
  });

  it('reports an exhausted allowance by status', async () => {
    fetchMock.mockResolvedValue(fail(429, 'Limit reached'));
    await expect(submitDocumentTranslation(file, 'es')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('refuses a result that is not a paged job', async () => {
    fetchMock.mockResolvedValue(ok({ jobId: 'sync', translatedFilename: 'x' }));
    await expect(submitDocumentTranslation(file, 'es')).rejects.toMatchObject({
      code: 'NOT_A_PAGED_JOB',
    });
  });
});

describe('fetchDocumentJobStatus', () => {
  it('maps each server status', async () => {
    fetchMock.mockResolvedValueOnce(ok({ status: 'Running' }));
    await expect(fetchDocumentJobStatus('j')).resolves.toEqual({
      status: 'Running',
    });

    const reference = { jobId: 'j', expiresAt: '2026-11-21T00:00:00Z' };
    fetchMock.mockResolvedValueOnce(ok({ status: 'Succeeded', reference }));
    await expect(fetchDocumentJobStatus('j')).resolves.toEqual({
      status: 'Succeeded',
      reference,
    });

    fetchMock.mockResolvedValueOnce(ok({ status: 'Failed', error: 'bad pdf' }));
    await expect(fetchDocumentJobStatus('j')).resolves.toEqual({
      status: 'Failed',
      error: 'bad pdf',
    });
  });

  it('reports a lost job as NotFound, not as an error', async () => {
    fetchMock.mockResolvedValue(fail(404, 'Job not found'));
    await expect(fetchDocumentJobStatus('j')).resolves.toEqual({
      status: 'NotFound',
    });
  });

  it('throws on a transient failure', async () => {
    fetchMock.mockResolvedValue(fail(500, 'boom'));
    await expect(fetchDocumentJobStatus('j')).rejects.toBeInstanceOf(
      DocumentJobError,
    );
  });
});

describe('pages and corrections', () => {
  it('requests the window and returns the pages', async () => {
    const pages = {
      pageCount: 9,
      from: 6,
      to: 9,
      pages: [],
      correctedPages: [],
    };
    fetchMock.mockResolvedValue(ok(pages));
    await expect(fetchDocumentJobPages('j', 6, 10)).resolves.toEqual(pages);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/document-translation/pages/j?from=6&to=10',
    );
  });

  it('saves a correction and returns the corrected pages', async () => {
    fetchMock.mockResolvedValue(ok({ page: 3, correctedPages: [3, 7] }));
    await expect(saveDocumentPageCorrection('j', 3, 'texto')).resolves.toEqual([
      3, 7,
    ]);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      page: 3,
      text: 'texto',
    });
  });

  it('sends null to remove a correction', async () => {
    fetchMock.mockResolvedValue(ok({ page: 3, correctedPages: [] }));
    await saveDocumentPageCorrection('j', 3, null);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      page: 3,
      text: null,
    });
  });

  it('throws with the server message when a correction is refused', async () => {
    fetchMock.mockResolvedValue(fail(400, 'Too long', 'INVALID_CORRECTION'));
    await expect(saveDocumentPageCorrection('j', 3, 'x')).rejects.toMatchObject(
      { message: 'Too long', code: 'INVALID_CORRECTION' },
    );
  });
});

describe('download URLs', () => {
  it('encodes the filename', () => {
    expect(translatedFileUrl('j', 'Guía clínica_es.pdf', 'pdf')).toBe(
      '/api/document-translation/content/j?filename=Gu%C3%ADa%20cl%C3%ADnica_es.pdf&ext=pdf',
    );
    expect(textVersionUrl('j')).toBe(
      '/api/document-translation/export/j?format=docx',
    );
  });
});
