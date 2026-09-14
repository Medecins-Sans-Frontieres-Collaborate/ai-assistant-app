/**
 * Budgeted auto-OCR inside `indexJobItem`: a scanned PDF is OCR'd only
 * within the run's shared page budget and the per-file cap; the budget is
 * reserved synchronously so concurrent items cannot oversubscribe it, and
 * refunded when the engine is unavailable or fails.
 */
import { NextRequest } from 'next/server';

import type { M365ManifestItem } from '@/lib/services/agentAccess/types';
import { indexJobItem } from '@/lib/services/m365/agentIndexService';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const fh = vi.hoisted(() => {
  class NoExtractableTextError extends Error {}
  return {
    NoExtractableTextError,
    loadDocument: vi.fn(),
    countPdfPages: vi.fn(),
  };
});
vi.mock('@/lib/utils/server/file/fileHandling', () => fh);

const prep = vi.hoisted(() => {
  class OcrEngineUnavailableError extends Error {}
  return { OcrEngineUnavailableError, ocrPdfBuffer: vi.fn() };
});
vi.mock('@/lib/services/m365/agentPreparationService', () => prep);

vi.mock('@/config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/environment')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      M365_AGENTS_SEARCH_ENDPOINT: 'https://example.search.windows.net',
      M365_AGENTS_SEARCH_INDEX: 'm365-agents',
    },
  };
});

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return {
    ...actual,
    // No `name`: the item's own name is the fallback, so each test's
    // extension drives the PDF check.
    graphJson: vi.fn(async () => ({
      size: 10,
      eTag: '"e1"',
      lastModifiedDateTime: '2026-09-14T00:00:00.000Z',
    })),
    graphFetch: vi.fn(async () => new Response(Buffer.from('%PDF-1.4 stub'))),
  };
});
vi.mock('@/lib/services/m365/documentSignature', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/m365/documentSignature')
    >();
  return { ...actual, checkDocumentSignature: () => ({ ok: true }) };
});

const mergeOrUpload = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@azure/search-documents', () => ({
  SearchClient: class {
    mergeOrUploadDocuments = mergeOrUpload;
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({
      getAzureOpenAIClient: () => ({
        embeddings: {
          create: async ({ input }: { input: string[] }) => ({
            data: input.map(() => ({ embedding: [0.1, 0.2] })),
          }),
        },
      }),
    }),
  },
}));

const req = new NextRequest('http://localhost/api/x');
const item: M365ManifestItem = {
  itemId: 'i1',
  driveId: 'd1',
  name: 'scan.pdf',
  path: '',
  parentItemId: 'root',
  size: 10,
  eTag: '"e1"',
  webUrl: 'https://contoso.sharepoint.com/scan.pdf',
  tier: 'indexable',
};

const run = (budget?: { remainingPages: number; maxPagesPerFile: number }) =>
  indexJobItem(req, 'm365-abcdefabcdef', 'emb', 's1', item, undefined, {
    autoOcr: budget,
  });

beforeEach(() => {
  vi.clearAllMocks();
  fh.loadDocument.mockRejectedValue(new fh.NoExtractableTextError('scan'));
  fh.countPdfPages.mockResolvedValue(12);
  prep.ocrPdfBuffer.mockResolvedValue({
    text: 'Recovered text from the scanned pages, long enough to chunk.',
    pages: 12,
    engine: 'di',
  });
});

describe('indexJobItem auto-OCR', () => {
  it('without a budget a scan is plain noText (today’s behaviour)', async () => {
    const out = await run(undefined);
    expect(out).toMatchObject({ status: 'noText', indexedChunks: 0 });
    expect(out.ocrSkipped).toBeUndefined();
    expect(prep.ocrPdfBuffer).not.toHaveBeenCalled();
  });

  it('OCRs within budget, indexes the text and reports the pages spent', async () => {
    const budget = { remainingPages: 100, maxPagesPerFile: 50 };
    const out = await run(budget);
    expect(out).toMatchObject({ status: 'indexed', ocrPages: 12 });
    expect(out.indexedChunks).toBeGreaterThan(0);
    expect(mergeOrUpload).toHaveBeenCalledTimes(1);
    expect(prep.ocrPdfBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'scan.pdf',
      expect.objectContaining({ maxPages: 12 }),
    );
    expect(budget.remainingPages).toBe(88);
  });

  it('skips files over the per-file cap without spending budget', async () => {
    fh.countPdfPages.mockResolvedValue(80);
    const budget = { remainingPages: 200, maxPagesPerFile: 50 };
    const out = await run(budget);
    expect(out).toMatchObject({ status: 'noText', ocrSkipped: 'tooManyPages' });
    expect(budget.remainingPages).toBe(200);
    expect(prep.ocrPdfBuffer).not.toHaveBeenCalled();
  });

  it('skips when the run budget is spent', async () => {
    const budget = { remainingPages: 5, maxPagesPerFile: 50 };
    const out = await run(budget);
    expect(out).toMatchObject({ status: 'noText', ocrSkipped: 'budget' });
    expect(prep.ocrPdfBuffer).not.toHaveBeenCalled();
  });

  it('reserves synchronously: two concurrent 50-page items on a 60-page budget → second skipped', async () => {
    fh.countPdfPages.mockResolvedValue(50);
    let release!: () => void;
    prep.ocrPdfBuffer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              text: 'OCR text long enough to chunk ok.',
              pages: 50,
              engine: 'di',
            });
        }),
    );
    const budget = { remainingPages: 60, maxPagesPerFile: 50 };
    const first = run(budget);
    const second = run(budget);
    const secondOut = await second;
    expect(secondOut).toMatchObject({ status: 'noText', ocrSkipped: 'budget' });
    // The first item reserved its pages before the second was checked; its
    // OCR call follows a dynamic import, so wait for it before releasing.
    await vi.waitFor(() => expect(prep.ocrPdfBuffer).toHaveBeenCalledTimes(1));
    release();
    const firstOut = await first;
    expect(firstOut).toMatchObject({ status: 'indexed', ocrPages: 50 });
    expect(prep.ocrPdfBuffer).toHaveBeenCalledTimes(1);
    expect(budget.remainingPages).toBe(10);
  });

  it('refunds the reservation when the engine is unavailable', async () => {
    prep.ocrPdfBuffer.mockRejectedValue(
      new prep.OcrEngineUnavailableError('no DI'),
    );
    const budget = { remainingPages: 100, maxPagesPerFile: 50 };
    const out = await run(budget);
    expect(out).toMatchObject({
      status: 'noText',
      ocrSkipped: 'engineUnavailable',
    });
    expect(budget.remainingPages).toBe(100);
  });

  it('marks an OCR failure as failed with the reason, refunding the pages', async () => {
    prep.ocrPdfBuffer.mockRejectedValue(new Error('DI 429 throttled'));
    const budget = { remainingPages: 100, maxPagesPerFile: 50 };
    const out = await run(budget);
    expect(out).toMatchObject({
      status: 'failed',
      error: 'OCR: DI 429 throttled',
    });
    expect(budget.remainingPages).toBe(100);
  });

  it('keeps the page count when OCR finds nothing (blank scan)', async () => {
    prep.ocrPdfBuffer.mockResolvedValue({
      text: '   ',
      pages: 12,
      engine: 'vision',
    });
    const budget = { remainingPages: 100, maxPagesPerFile: 50 };
    const out = await run(budget);
    expect(out).toMatchObject({ status: 'noText', ocrPages: 12 });
    expect(out.ocrSkipped).toBeUndefined();
    expect(budget.remainingPages).toBe(88);
  });

  it('never OCRs a non-PDF and leaves noText untouched', async () => {
    const budget = { remainingPages: 100, maxPagesPerFile: 50 };
    const out = await indexJobItem(
      req,
      'm365-abcdefabcdef',
      'emb',
      's1',
      { ...item, name: 'empty.docx' },
      undefined,
      { autoOcr: budget },
    );
    expect(out.status).toBe('noText');
    expect(prep.ocrPdfBuffer).not.toHaveBeenCalled();
  });
});
