import { FetchUrlError } from '@/lib/utils/server/net/fetchUrlError';

import { createMockRequest, createMockSession } from './helpers';

import { POST } from '@/app/api/workflows/fetch-url/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockFetchPublicUrl = vi.hoisted(() => vi.fn());
const mockExtract = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
// Keep readBodyWithLimit real — the size cap is part of what we assert here.
vi.mock('@/lib/utils/server/net/publicUrlGuard', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/utils/server/net/publicUrlGuard')
    >();
  return { ...actual, fetchPublicUrl: mockFetchPublicUrl };
});
vi.mock('@/lib/services/workflows/shared/articleExtraction', () => ({
  extractReadableContent: mockExtract,
}));

function request(body: unknown) {
  return createMockRequest({
    method: 'POST',
    url: 'http://localhost:3000/api/workflows/fetch-url',
    body,
  });
}

/** Canned upstream response for the guard to hand back. */
function upstream(
  body: string | null,
  init: { status?: number; headers?: Record<string, string> } = {},
  resolvedUrl = 'https://example.com/article',
) {
  mockFetchPublicUrl.mockResolvedValue({
    response: new Response(body, init),
    resolvedUrl,
  });
}

const html = '<!doctype html><html><body><p>Bor</p></body></html>';

async function post(body: unknown = { url: 'https://example.com/article' }) {
  const response = await POST(request(body));
  return { response, json: await response.json() };
}

describe('/api/workflows/fetch-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockExtract.mockResolvedValue({
      text: 'Floodwaters reached Bor on Tuesday.',
      title: 'Floods in Jonglei',
      siteName: 'Example News',
      extractedVia: 'readability',
      truncated: false,
    });
  });

  it('rejects unauthenticated requests', async () => {
    mockAuth.mockResolvedValue(null);
    const { response } = await post();
    expect(response.status).toBe(401);
    expect(mockFetchPublicUrl).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ url: '' }], [{ url: '   ' }]])(
    'rejects a missing URL (%j)',
    async (body) => {
      const { response, json } = await post(body);
      expect(response.status).toBe(400);
      expect(json.code).toBe('INVALID_URL');
    },
  );

  it('returns the extracted page on success', async () => {
    upstream(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    const { response, json } = await post();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({
      text: 'Floodwaters reached Bor on Tuesday.',
      title: 'Floods in Jonglei',
      resolvedUrl: 'https://example.com/article',
      extractedVia: 'readability',
    });
  });

  it.each([
    ['401 sign-in wall', 401, 'BLOCKED', 403],
    ['403 bot block', 403, 'BLOCKED', 403],
    ['429 rate limited', 429, 'BLOCKED', 403],
    ['404 missing', 404, 'NOT_FOUND', 404],
    ['410 gone', 410, 'NOT_FOUND', 404],
    ['500 upstream', 500, 'UPSTREAM_ERROR', 502],
    ['503 upstream', 503, 'UPSTREAM_ERROR', 502],
  ])('maps %s to %s', async (_label, upstreamStatus, code, status) => {
    upstream('nope', {
      status: upstreamStatus,
      headers: { 'content-type': 'text/html' },
    });

    const { response, json } = await post();

    expect(json.code).toBe(code);
    expect(response.status).toBe(status);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('rejects a PDF by content type without downloading it', async () => {
    upstream('%PDF-1.7 ...', {
      headers: { 'content-type': 'application/pdf' },
    });

    const { response, json } = await post();

    expect(response.status).toBe(415);
    expect(json.code).toBe('PDF');
  });

  it('rejects a PDF that is mislabelled as a binary download', async () => {
    upstream('%PDF-1.7 trailing bytes', {
      headers: { 'content-type': 'application/octet-stream' },
    });

    const { response, json } = await post();

    expect(response.status).toBe(415);
    expect(json.code).toBe('PDF');
  });

  it('rejects an unsupported content type', async () => {
    upstream('binary', { headers: { 'content-type': 'image/png' } });

    const { response, json } = await post();

    expect(response.status).toBe(415);
    expect(json.code).toBe('NON_HTML');
  });

  it('accepts plain text and flags it as non-HTML for the extractor', async () => {
    upstream('Displacement reported near Malakal.', {
      headers: { 'content-type': 'text/plain' },
    });

    const { response } = await post();

    expect(response.status).toBe(200);
    expect(mockExtract).toHaveBeenCalledWith(
      expect.objectContaining({ isHtml: false }),
    );
  });

  it('sniffs HTML when the server does not commit to a type', async () => {
    upstream(html, { headers: { 'content-type': 'application/octet-stream' } });

    await post();

    expect(mockExtract).toHaveBeenCalledWith(
      expect.objectContaining({ isHtml: true }),
    );
  });

  it('enforces the response size cap', async () => {
    upstream('x'.repeat(16), {
      headers: {
        'content-type': 'text/html',
        'content-length': String(50 * 1024 * 1024),
      },
    });

    const { response, json } = await post();

    expect(response.status).toBe(413);
    expect(json.code).toBe('TOO_LARGE');
  });

  it('surfaces a guard rejection as SSRF_BLOCKED', async () => {
    mockFetchPublicUrl.mockRejectedValue(
      new FetchUrlError('SSRF_BLOCKED', 'Blocked non-public request URL'),
    );

    const { response, json } = await post();

    expect(response.status).toBe(400);
    expect(json.code).toBe('SSRF_BLOCKED');
  });

  it('surfaces an empty extraction', async () => {
    upstream(html, { headers: { 'content-type': 'text/html' } });
    mockExtract.mockRejectedValue(
      new FetchUrlError('EMPTY_EXTRACTION', 'No readable text found'),
    );

    const { response, json } = await post();

    expect(response.status).toBe(422);
    expect(json.code).toBe('EMPTY_EXTRACTION');
  });

  it('falls back to UNREACHABLE for an unexpected failure', async () => {
    mockFetchPublicUrl.mockRejectedValue(new Error('kaboom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { response, json } = await post();

    expect(response.status).toBe(502);
    expect(json.code).toBe('UNREACHABLE');
    errorSpy.mockRestore();
  });

  it('passes the conversation model through for the cleanup fallback', async () => {
    upstream(html, { headers: { 'content-type': 'text/html' } });

    await post({ url: 'https://example.com/a', modelId: 'gpt-5.2' });

    expect(mockExtract).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.2' }),
    );
  });
});
