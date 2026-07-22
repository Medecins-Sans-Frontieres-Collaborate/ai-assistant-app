import {
  URL_ERROR_KEYS,
  fetchUrlContent,
  hostnameOf,
  isLikelyUrl,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';

import messages from '@/messages/en.json';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('isLikelyUrl', () => {
  it.each([
    'https://example.com/article',
    'http://example.com',
    'example.com',
    'www.bbc.co.uk/news/world-123',
    'reliefweb.int/report/sudan/floods?x=1',
    'https://sub.domain.example.org/a/b#frag',
  ])('accepts %s', (value) => {
    expect(isLikelyUrl(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['prose with a comma', 'Paris, France'],
    ['a measurement', '3.5 mm'],
    ['a bare number pair', '3.5'],
    ['a sentence', 'Flooding was reported in Juba and Bor.'],
    ['a single word', 'Khartoum'],
    ['a filename', 'notes.md'],
    ['a spreadsheet', 'line-list.xlsx'],
    ['a link inside prose', 'see https://example.com for details'],
    ['multi-line text', 'https://example.com\nand more text'],
  ])('rejects %s', (_label, value) => {
    expect(isLikelyUrl(value)).toBe(false);
  });

  it('rejects an over-long URL', () => {
    expect(isLikelyUrl(`https://example.com/${'a'.repeat(2100)}`)).toBe(false);
  });

  it('accepts a document extension only when the scheme is explicit', () => {
    expect(isLikelyUrl('notes.md')).toBe(false);
    expect(isLikelyUrl('https://notes.md')).toBe(true);
  });
});

describe('hostnameOf', () => {
  it('strips a www prefix', () => {
    expect(hostnameOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });

  it('returns empty for junk', () => {
    expect(hostnameOf('not a url')).toBe('');
  });
});

describe('urlErrorKey', () => {
  it('falls back to generic for unknown or missing codes', () => {
    expect(urlErrorKey(undefined)).toBe('errors.generic');
    expect(urlErrorKey('SOMETHING_NEW')).toBe('errors.generic');
  });

  it('maps a known code', () => {
    expect(urlErrorKey('BLOCKED')).toBe('errors.blocked');
  });

  /**
   * Guards the contract between the server's code union and the shared
   * `urlFetch` namespace: a code shipped without a string would render a raw
   * key path to the user.
   */
  it('resolves every error code, plus generic, to a real message', () => {
    const urlFetch = (
      messages as unknown as {
        urlFetch: {
          errors: Record<string, string>;
          fallbackHint: string;
          doc: Record<string, string>;
        };
      }
    ).urlFetch;

    for (const code of Object.keys(URL_ERROR_KEYS)) {
      const leaf = urlErrorKey(code).replace('errors.', '');
      expect(urlFetch.errors[leaf], `missing message for ${code}`).toBeTruthy();
    }
    expect(urlFetch.errors.generic).toBeTruthy();
    expect(urlFetch.fallbackHint).toBeTruthy();
    // Consumed by the attachment document builders.
    for (const key of [
      'sourceLabel',
      'retrievedLabel',
      'attemptedLabel',
      'failureHeading',
    ]) {
      expect(urlFetch.doc[key], `missing doc.${key}`).toBeTruthy();
    }
  });
});

describe('fetchUrlContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the page on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: true, data: { text: 'hi', title: 'T' } }),
      ),
    );

    const result = await fetchUrlContent('https://example.com');

    expect(result).toMatchObject({ ok: true, page: { text: 'hi' } });
  });

  it('reports the server error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'nope', code: 'BLOCKED' }, { status: 403 }),
      ),
    );

    expect(await fetchUrlContent('https://example.com')).toEqual({
      ok: false,
      code: 'BLOCKED',
    });
  });

  /** Never throwing is what stops an attachment being stuck mid-flight. */
  it('converts a thrown network error into a code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );

    expect(await fetchUrlContent('https://example.com')).toEqual({
      ok: false,
      code: 'UNREACHABLE',
    });
  });

  it('reports an aborted request as a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        throw err;
      }),
    );

    expect(await fetchUrlContent('https://example.com')).toEqual({
      ok: false,
      code: 'TIMEOUT',
    });
  });

  /** Without a bound, an in-flight attachment could block sending forever. */
  it('applies a client-side timeout when the caller gives no signal', async () => {
    const spy = vi.fn(async () => Response.json({ success: true, data: {} }));
    vi.stubGlobal('fetch', spy);

    await fetchUrlContent('https://example.com');

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
