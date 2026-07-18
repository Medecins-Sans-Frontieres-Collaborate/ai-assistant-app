import { FetchUrlError } from '@/lib/utils/server/net/fetchUrlError';
import {
  fetchPublicUrl,
  isHttpsPublicShapedUrl,
  normalizeInputUrl,
  readBodyWithLimit,
} from '@/lib/utils/server/net/publicUrlGuard';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

beforeEach(() => {
  mockLookup.mockReset();
  // Default: every hostname resolves to a public address.
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

/** Minimal fetch double returning canned responses per URL. */
function fakeFetch(byUrl: Record<string, Response | (() => Response)>) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = byUrl[url];
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    return typeof entry === 'function' ? entry() : entry;
  });
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (err) {
    if (err instanceof FetchUrlError) return err.code;
    throw err;
  }
}

describe('normalizeInputUrl', () => {
  it('adds a scheme to a bare domain', () => {
    expect(normalizeInputUrl('example.com/news')).toBe(
      'https://example.com/news',
    );
  });

  it('upgrades http to https rather than fetching cleartext', () => {
    expect(normalizeInputUrl('http://example.com/a')).toBe(
      'https://example.com/a',
    );
  });

  it.each([
    ['empty', ''],
    ['non-http scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['over length', `https://example.com/${'a'.repeat(2100)}`],
  ])('rejects %s', async (_label, value) => {
    expect(() => normalizeInputUrl(value)).toThrow(FetchUrlError);
  });
});

describe('fetchPublicUrl', () => {
  it('returns the final response and resolved URL after a redirect', async () => {
    const impl = fakeFetch({
      'https://example.com/a': redirectTo('https://example.com/b'),
      'https://example.com/b': new Response('ok', { status: 200 }),
    });

    const { response, resolvedUrl } = await fetchPublicUrl(
      'https://example.com/a',
      { fetchImpl: impl },
    );

    expect(response.status).toBe(200);
    expect(resolvedUrl).toBe('https://example.com/b');
    expect(impl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('re-validates the host on EVERY hop, not just the first', async () => {
    const impl = fakeFetch({
      'https://a.example.com/': redirectTo('https://b.example.com/'),
      'https://b.example.com/': redirectTo('https://c.example.com/'),
      'https://c.example.com/': new Response('ok', { status: 200 }),
    });

    await fetchPublicUrl('https://a.example.com/', { fetchImpl: impl });

    // One DNS check per hop — this is what bounds the rebinding window.
    expect(mockLookup).toHaveBeenCalledTimes(3);
  });

  it('blocks a redirect to the cloud metadata endpoint', async () => {
    const impl = fakeFetch({
      'https://example.com/': redirectTo(
        'https://169.254.169.254/latest/meta-data',
      ),
    });

    expect(
      await codeOf(fetchPublicUrl('https://example.com/', { fetchImpl: impl })),
    ).toBe('SSRF_BLOCKED');
  });

  it('blocks a redirect that downgrades to http', async () => {
    const impl = fakeFetch({
      'https://example.com/': redirectTo('http://example.com/plain'),
    });

    expect(
      await codeOf(fetchPublicUrl('https://example.com/', { fetchImpl: impl })),
    ).toBe('SSRF_BLOCKED');
  });

  it('blocks a public-looking host that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const impl = fakeFetch({
      'https://sneaky.example.com/': new Response('ok'),
    });

    expect(
      await codeOf(
        fetchPublicUrl('https://sneaky.example.com/', { fetchImpl: impl }),
      ),
    ).toBe('SSRF_BLOCKED');
    expect(impl).not.toHaveBeenCalled();
  });

  it('resolves a relative Location against the current hop', async () => {
    const impl = fakeFetch({
      'https://example.com/dir/page': redirectTo('/other'),
      'https://example.com/other': new Response('ok', { status: 200 }),
    });

    const { resolvedUrl } = await fetchPublicUrl(
      'https://example.com/dir/page',
      { fetchImpl: impl },
    );
    expect(resolvedUrl).toBe('https://example.com/other');
  });

  it('breaks a redirect cycle', async () => {
    const impl = fakeFetch({
      'https://example.com/a': redirectTo('https://example.com/b'),
      'https://example.com/b': redirectTo('https://example.com/a'),
    });

    expect(
      await codeOf(
        fetchPublicUrl('https://example.com/a', { fetchImpl: impl }),
      ),
    ).toBe('TOO_MANY_REDIRECTS');
  });

  it('gives up after the hop limit', async () => {
    let n = 0;
    const impl = vi.fn(async () => redirectTo(`https://example.com/${n++}`));

    expect(
      await codeOf(
        fetchPublicUrl('https://example.com/start', {
          fetchImpl: impl,
          maxHops: 3,
        }),
      ),
    ).toBe('TOO_MANY_REDIRECTS');
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('reports a redirect with no Location as unreachable', async () => {
    const impl = fakeFetch({
      'https://example.com/': new Response(null, { status: 302 }),
    });

    expect(
      await codeOf(fetchPublicUrl('https://example.com/', { fetchImpl: impl })),
    ).toBe('UNREACHABLE');
  });

  it('maps a network failure to UNREACHABLE', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    expect(
      await codeOf(fetchPublicUrl('https://example.com/', { fetchImpl: impl })),
    ).toBe('UNREACHABLE');
  });

  it('maps an abort to TIMEOUT', async () => {
    const impl = vi.fn(async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    });

    expect(
      await codeOf(fetchPublicUrl('https://example.com/', { fetchImpl: impl })),
    ).toBe('TIMEOUT');
  });
});

describe('readBodyWithLimit', () => {
  function streamOf(chunks: Uint8Array[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((c) => controller.enqueue(c));
        controller.close();
      },
    });
    return new Response(stream);
  }

  it('reads a body under the cap', async () => {
    const bytes = await readBodyWithLimit(new Response('hello'), 1000);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('rejects when the streamed body exceeds the cap', async () => {
    const chunk = new Uint8Array(600);
    expect(
      await codeOf(readBodyWithLimit(streamOf([chunk, chunk]), 1000)),
    ).toBe('TOO_LARGE');
  });

  it('rejects early on an oversized content-length', async () => {
    const response = new Response('x', {
      headers: { 'content-length': '99999999' },
    });
    expect(await codeOf(readBodyWithLimit(response, 1000))).toBe('TOO_LARGE');
  });

  it('still enforces the cap when content-length lies', async () => {
    const chunk = new Uint8Array(600);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { 'content-length': '5' },
    });
    expect(await codeOf(readBodyWithLimit(response, 1000))).toBe('TOO_LARGE');
  });
});

describe('isHttpsPublicShapedUrl (moved, still enforced)', () => {
  it('accepts a public https URL', () => {
    expect(isHttpsPublicShapedUrl('https://example.com/x')).toBe(true);
  });

  it.each([
    'http://example.com',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
  ])('rejects %s', (url) => {
    expect(isHttpsPublicShapedUrl(url)).toBe(false);
  });
});
