import { NextRequest } from 'next/server';

import { WORKFLOW_FEATURE_DISABLED_CODE } from '@/lib/services/workflows/policy/guard';

import {
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_PAGES,
} from '@/lib/utils/shared/translation/nativePdf';

import { parseJsonResponse } from './helpers';

import { POST as RENDER } from '@/app/api/document-translation/native/render/route';
import { GET, POST } from '@/app/api/document-translation/native/route';
import { POST as UNIT } from '@/app/api/document-translation/native/unit/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin policy (Admin > Workflows) is the only switch for the native PDF
 * routes: no environment variable is involved.
 */
const mockAuth = vi.hoisted(() => vi.fn());
const featureEnabled = vi.hoisted(() => vi.fn());
const featureLimits = vi.hoisted(() => vi.fn());
const rerender = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const storeFile = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/workflows/policy/WorkflowPolicyService', () => ({
  WorkflowPolicyService: {
    getInstance: () => ({
      ensureFresh: vi.fn().mockResolvedValue(undefined),
      isFeatureEnabled: featureEnabled,
      featureLimits,
    }),
  },
}));
vi.mock(
  '@/lib/services/documentTranslation/native/nativePdfPipeline',
  async (importOriginal) => ({
    // The real limit error, so the route's `instanceof` is exercised.
    NativePdfDocumentLimitError: (
      await importOriginal<
        typeof import('@/lib/services/documentTranslation/native/nativePdfPipeline')
      >()
    ).NativePdfDocumentLimitError,
    runNativePdfTranslation: vi.fn(),
    rerenderNativePdf: rerender,
    reviseNativeUnit: vi.fn(),
  }),
);
vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: () => ({
    userId: 'u1',
    mail: 'u1@example.org',
    domain: 'example.org',
    attributes: [],
    groupIds: [],
  }),
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfStorage', () => ({
  storeNativeFile: storeFile,
  storeNativeRebuild: vi.fn(async () => ({
    pdfUrl: '/out.pdf',
    pageImages: [],
  })),
  readNativeFile: readFile,
  isNativeFileId: (id: unknown, kind: string) =>
    typeof id === 'string' && id.endsWith(`.${kind}`),
}));
vi.mock('@/lib/services/documentTranslation/native/nativePdfGlossary', () => ({
  resolveRequestGlossary: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi.fn(async () => ({
    denied: null,
    usage: { fields: () => ({}) },
  })),
}));

/** What the policy resolves for the signed-in person. */
const LIMITS = { defaultBatchPages: 3, maxBatchPages: 4, maxDocumentPages: 5 };

/** A run request for the given pages, valid up to the page check. */
function runRequest(pages: string) {
  const form = new FormData();
  form.append('file', new File(['%PDF-1.4'], 'a.pdf'));
  form.append('targetLanguage', 'French');
  form.append('pages', pages);
  // Stops the request right after the page check, before any work.
  form.append('depth', 'not-a-depth');
  return new NextRequest('http://localhost/api/document-translation/native', {
    method: 'POST',
    body: form,
  });
}

const renderRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/document-translation/native/render', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const post = (path: string) =>
  new NextRequest(`http://localhost/api/document-translation/native${path}`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });

describe('native PDF routes follow the admin policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    featureLimits.mockReturnValue(LIMITS);
  });

  it('GET reports the feature as the policy has it, in both directions', async () => {
    featureEnabled.mockReturnValue(true);
    const on = await parseJsonResponse(await GET());
    expect(on.data.enabled).toBe(true);
    expect(on.data.maxPages).toBe(NATIVE_PDF_MAX_PAGES);
    expect(featureEnabled).toHaveBeenCalledWith(NATIVE_PDF_FEATURE);

    featureEnabled.mockReturnValue(false);
    const off = await parseJsonResponse(await GET());
    expect(off.data.enabled).toBe(false);
  });

  it('every POST route refuses with a stable code while the feature is off', async () => {
    featureEnabled.mockReturnValue(false);
    for (const response of [
      await POST(post('')),
      await RENDER(post('/render')),
      await UNIT(post('/unit')),
    ]) {
      expect(response.status).toBe(403);
      const body = await parseJsonResponse(response);
      expect(body.code).toBe(WORKFLOW_FEATURE_DISABLED_CODE);
    }
  });

  it('POST routes get past the gate while the feature is on', async () => {
    featureEnabled.mockReturnValue(true);
    for (const response of [
      await POST(post('')),
      await RENDER(post('/render')),
      await UNIT(post('/unit')),
    ]) {
      // An empty body fails validation, which only runs after the gate.
      expect(response.status).toBe(400);
    }
  });

  it('401s before consulting the policy when signed out', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(post(''))).status).toBe(401);
    expect(featureEnabled).not.toHaveBeenCalled();
  });
});

describe('native PDF limits come from the admin policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    featureEnabled.mockReturnValue(true);
    featureLimits.mockReturnValue(LIMITS);
    readFile.mockResolvedValue(Buffer.from('{}'));
    storeFile.mockResolvedValue({ id: 'joined.json', url: '/joined' });
    rerender.mockResolvedValue({
      fits: [],
      issues: [],
      checkedPages: [],
      uncheckedPages: [],
      fonts: { sans: 'A', serif: 'B' },
      repaired: [],
      tooLong: [],
      pdf: new Uint8Array(),
      outputs: [],
      unitsFile: new Uint8Array([1]),
    });
  });

  it("GET answers the person's limits, resolved for them", async () => {
    const body = await parseJsonResponse(await GET());
    expect(body.data.limits).toEqual(LIMITS);
    expect(featureLimits).toHaveBeenCalledWith(
      NATIVE_PDF_FEATURE,
      expect.objectContaining({ mail: 'u1@example.org' }),
    );
  });

  it('GET puts limits saved out of order in order', async () => {
    featureLimits.mockReturnValue({
      defaultBatchPages: 9,
      maxBatchPages: 7,
      maxDocumentPages: 5,
    });
    const body = await parseJsonResponse(await GET());
    expect(body.data.limits).toEqual({
      defaultBatchPages: 5,
      maxBatchPages: 5,
      maxDocumentPages: 5,
    });
  });

  it('a request takes the largest batch at most when that is below a request', async () => {
    // Largest batch 4, below the 6 a request takes: 4 pages pass the page
    // check (and stop at the next one), 5 do not.
    const atLimit = await parseJsonResponse(await POST(runRequest('1-4')));
    expect(atLimit.error).toMatch(/depth/);
    const over = await parseJsonResponse(await POST(runRequest('1-5')));
    expect(over.error).toMatch(/At most 4 pages/);
  });

  it("a request never takes more than one request's pages, whatever the batch", async () => {
    featureLimits.mockReturnValue({
      defaultBatchPages: 12,
      maxBatchPages: 24,
      maxDocumentPages: 100,
    });
    const atLimit = await parseJsonResponse(
      await POST(runRequest(`1-${NATIVE_PDF_MAX_PAGES}`)),
    );
    expect(atLimit.error).toMatch(/depth/);
    const over = await parseJsonResponse(
      await POST(runRequest(`1-${NATIVE_PDF_MAX_PAGES + 1}`)),
    );
    expect(over.error).toMatch(
      new RegExp(`At most ${NATIVE_PDF_MAX_PAGES} pages`),
    );
  });

  it('render joins several extractions and names the joined one', async () => {
    const response = await RENDER(
      renderRequest({
        sourceId: 'doc.pdf',
        unitsIds: ['a.json', 'b.json'],
        translations: { p1u1: 'x' },
        imagePages: [],
      }),
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body.data.unitsId).toBe('joined.json');
    expect(storeFile).toHaveBeenCalledTimes(1);
    expect(rerender.mock.calls[0][0]).toMatchObject({
      imagePages: [],
      checkPages: [],
      maxDocumentPages: LIMITS.maxDocumentPages,
    });
    expect(rerender.mock.calls[0][0].unitsFiles).toHaveLength(2);
  });

  it('render with one extraction keeps its id and stores nothing new', async () => {
    const body = await parseJsonResponse(
      await RENDER(
        renderRequest({
          sourceId: 'doc.pdf',
          unitsId: 'a.json',
          translations: { p1u1: 'x' },
        }),
      ),
    );
    expect(body.data.unitsId).toBe('a.json');
    expect(storeFile).not.toHaveBeenCalled();
    // No `imagePages`: every translated page is drawn, as before.
    expect(rerender.mock.calls[0][0].imagePages).toBeUndefined();
  });

  it('render refuses a document past its page limit with its own code', async () => {
    const { NativePdfDocumentLimitError } =
      await import('@/lib/services/documentTranslation/native/nativePdfPipeline');
    rerender.mockRejectedValue(new NativePdfDocumentLimitError(6, 5));
    const response = await RENDER(
      renderRequest({
        sourceId: 'doc.pdf',
        unitsId: 'a.json',
        translations: { p1u1: 'x' },
      }),
    );
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).code).toBe(
      'DOCUMENT_PAGE_LIMIT',
    );
  });

  it('render refuses ids that are not extractions', async () => {
    for (const body of [
      { sourceId: 'doc.pdf', unitsIds: [], translations: {} },
      { sourceId: 'doc.pdf', unitsIds: ['a.pdf'], translations: {} },
      { sourceId: 'doc.pdf', translations: {} },
    ]) {
      expect((await RENDER(renderRequest(body))).status).toBe(400);
    }
    expect(rerender).not.toHaveBeenCalled();
  });
});
