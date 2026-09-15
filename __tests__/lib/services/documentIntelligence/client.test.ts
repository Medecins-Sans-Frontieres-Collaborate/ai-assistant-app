import {
  DocumentIntelligenceError,
  analyzeDocument,
  isDocumentIntelligenceConfigured,
  pagesFromAnalyzeResult,
} from '@/lib/services/documentIntelligence/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  env: {
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://di.example.com/',
    AZURE_DOCUMENT_INTELLIGENCE_KEY: 'k',
  } as Record<string, string | undefined>,
}));
vi.mock('@/config/environment', () => envMock);

const fetchMock = vi.fn();

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function accepted(retryAfter = '0'): Response {
  return new Response(null, {
    status: 202,
    headers: {
      'operation-location': 'https://di.example.com/op/1',
      'retry-after': retryAfter,
    },
  });
}

const succeeded = {
  status: 'succeeded',
  analyzeResult: {
    content: 'Hello world\nSecond page',
    pages: [
      { pageNumber: 1, lines: [{ content: 'Hello' }, { content: 'world' }] },
      { pageNumber: 2, spans: [{ offset: 12, length: 11 }] },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  envMock.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'https://di.example.com/';
  envMock.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = 'k';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('documentIntelligence client', () => {
  it('reports configuration from env or explicit overrides', () => {
    expect(isDocumentIntelligenceConfigured()).toBe(true);
    envMock.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = undefined;
    expect(isDocumentIntelligenceConfigured()).toBe(false);
    expect(
      isDocumentIntelligenceConfigured({ endpoint: 'https://x', key: 'y' }),
    ).toBe(true);
  });

  it('submits with the pages selection, polls to success and maps pages (lines, then spans)', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted('0'))
      .mockResolvedValueOnce(json({ status: 'running' }))
      .mockResolvedValueOnce(json(succeeded));
    const result = await analyzeDocument(Buffer.from('%PDF'), {
      model: 'prebuilt-read',
      contentType: 'application/pdf',
      pages: '1-50',
      pollIntervalMs: 1,
    });
    const submitUrl = fetchMock.mock.calls[0][0] as string;
    expect(submitUrl).toBe(
      'https://di.example.com/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30&pages=1-50',
    );
    const submitInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(submitInit.method).toBe('POST');
    expect(
      (submitInit.headers as Record<string, string>)[
        'Ocp-Apim-Subscription-Key'
      ],
    ).toBe('k');
    expect((submitInit.headers as Record<string, string>)['Content-Type']).toBe(
      'application/pdf',
    );
    expect(fetchMock.mock.calls[1][0]).toBe('https://di.example.com/op/1');
    expect(result.content).toBe('Hello world\nSecond page');
    expect(result.pages).toEqual([
      { pageNumber: 1, text: 'Hello\nworld' },
      { pageNumber: 2, text: 'Second page' },
    ]);
  });

  it('honours Retry-After on the poll and keeps polling through a transient 503', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted('0'))
      .mockResolvedValueOnce(
        new Response('busy', { status: 503, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(
        json({ status: 'running' }, { headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(json(succeeded));
    const result = await analyzeDocument(Buffer.from('%PDF'), {
      model: 'prebuilt-read',
      contentType: 'application/pdf',
      pollIntervalMs: 1,
    });
    expect(result.pages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('surfaces a failed analysis with the service message', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted('0'))
      .mockResolvedValueOnce(
        json({ status: 'failed', error: { message: 'InvalidContent' } }),
      );
    await expect(
      analyzeDocument(Buffer.from('x'), {
        model: 'prebuilt-read',
        contentType: 'application/pdf',
        pollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ kind: 'failed', message: /InvalidContent/ });
  });

  it('maps a rejected submit to a submit error carrying the status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"message":"Invalid pages"}}', { status: 400 }),
    );
    await expect(
      analyzeDocument(Buffer.from('x'), {
        model: 'prebuilt-read',
        contentType: 'application/pdf',
        pages: '1-99',
      }),
    ).rejects.toMatchObject({ kind: 'submit', status: 400 });
  });

  it('times out instead of polling forever', async () => {
    fetchMock
      .mockResolvedValueOnce(accepted('0'))
      .mockResolvedValue(json({ status: 'running' }));
    await expect(
      analyzeDocument(Buffer.from('x'), {
        model: 'prebuilt-read',
        contentType: 'application/pdf',
        pollIntervalMs: 5,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('aborts while waiting between polls', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(accepted('5'));
    const promise = analyzeDocument(Buffer.from('x'), {
      model: 'prebuilt-read',
      contentType: 'application/pdf',
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(DocumentIntelligenceError);
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('refuses to run without configuration', async () => {
    envMock.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = undefined;
    await expect(
      analyzeDocument(Buffer.from('x'), {
        model: 'prebuilt-read',
        contentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ kind: 'config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pagesFromAnalyzeResult falls back to one page of content when the service sent no pages', () => {
    expect(pagesFromAnalyzeResult('only text', undefined)).toEqual([
      { pageNumber: 1, text: 'only text' },
    ]);
    expect(pagesFromAnalyzeResult('   ', [])).toEqual([]);
  });
});
