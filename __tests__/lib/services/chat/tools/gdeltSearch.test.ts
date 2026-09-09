import {
  __resetGdeltRateLimitForTests,
  buildGdeltQueryUrl,
  gdeltDateToIso,
  searchGdelt,
} from '@/lib/services/chat/tools/gdeltSearch';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('gdeltDateToIso', () => {
  it('converts GDELT seendate to ISO', () => {
    expect(gdeltDateToIso('20260721T080130Z')).toBe('2026-07-21T08:01:30Z');
    expect(
      new Date(gdeltDateToIso('20260721T080130Z')).getTime(),
    ).not.toBeNaN();
  });

  it('returns empty string for malformed input', () => {
    expect(gdeltDateToIso('')).toBe('');
    expect(gdeltDateToIso('2026-07-21')).toBe('');
  });
});

describe('buildGdeltQueryUrl', () => {
  it('quotes the query, filters to English, and maps freshness to timespan', () => {
    const url = new URL(
      buildGdeltQueryUrl('India protests', {
        resultCount: 8,
        freshness: 'day',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://api.gdeltproject.org/api/v2/doc/doc',
    );
    expect(url.searchParams.get('query')).toBe(
      '"India protests" sourcelang:eng',
    );
    expect(url.searchParams.get('timespan')).toBe('24h');
    expect(url.searchParams.get('mode')).toBe('ArtList');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('maxrecords')).toBe('16');
  });

  it('strips embedded quotes and caps maxrecords at 50', () => {
    const url = new URL(
      buildGdeltQueryUrl('say "hello"', { resultCount: 40, freshness: 'any' }),
    );
    expect(url.searchParams.get('query')).toBe('"say hello" sourcelang:eng');
    expect(url.searchParams.get('timespan')).toBe('3m');
    expect(url.searchParams.get('maxrecords')).toBe('50');
  });
});

describe('searchGdelt', () => {
  beforeEach(() => {
    // Without this, the 5s/request spacing throttle makes each subsequent
    // test case wait out the real-time window.
    __resetGdeltRateLimitForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (body: string, status = 200) => {
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('maps articles, dedupes by URL, and caps at resultCount', async () => {
    stubFetch(
      JSON.stringify({
        articles: [
          {
            title: 'Story A',
            url: 'https://pub-a.example/a',
            seendate: '20260721T080000Z',
            domain: 'pub-a.example',
          },
          {
            title: 'Story A again',
            url: 'https://pub-a.example/a',
            seendate: '20260721T080000Z',
            domain: 'pub-a.example',
          },
          {
            title: 'Story B',
            url: 'https://pub-b.example/b',
            seendate: '20260720T120000Z',
            domain: 'pub-b.example',
          },
          {
            title: 'Story C',
            url: 'https://pub-c.example/c',
            seendate: '20260719T090000Z',
            domain: 'pub-c.example',
          },
        ],
      }),
    );

    const articles = await searchGdelt('anything', {
      resultCount: 2,
      freshness: 'week',
    });

    expect(articles).toEqual([
      {
        title: 'Story A',
        url: 'https://pub-a.example/a',
        date: '2026-07-21T08:00:00Z',
        domain: 'pub-a.example',
      },
      {
        title: 'Story B',
        url: 'https://pub-b.example/b',
        date: '2026-07-20T12:00:00Z',
        domain: 'pub-b.example',
      },
    ]);
  });

  it('skips entries missing a url or title', async () => {
    stubFetch(
      JSON.stringify({
        articles: [
          { title: '', url: 'https://pub.example/x' },
          { title: 'No url' },
          {
            title: 'Valid',
            url: 'https://pub.example/ok',
            seendate: 'garbage',
            domain: 'pub.example',
          },
        ],
      }),
    );

    const articles = await searchGdelt('q', {
      resultCount: 5,
      freshness: 'any',
    });
    expect(articles).toEqual([
      {
        title: 'Valid',
        url: 'https://pub.example/ok',
        date: '',
        domain: 'pub.example',
      },
    ]);
  });

  it('throws a specific error on the rate-limit message', async () => {
    stubFetch('Please limit requests to one every 5 seconds or contact ...');
    await expect(
      searchGdelt('q', { resultCount: 5, freshness: 'any' }),
    ).rejects.toThrow(/rate limited/);
  });

  it('opens the circuit breaker after a 429: next call fails fast without fetching', async () => {
    const fetchMock = stubFetch('', 429);
    await expect(
      searchGdelt('q', { resultCount: 5, freshness: 'any' }),
    ).rejects.toThrow(/rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      searchGdelt('q', { resultCount: 5, freshness: 'any' }),
    ).rejects.toThrow(/cooldown/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when GDELT reports a query error as plain text', async () => {
    // GDELT signals bad queries with a 200 + text/plain body.
    stubFetch('Your query was too short or invalid.');
    await expect(
      searchGdelt('q', { resultCount: 5, freshness: 'any' }),
    ).rejects.toThrow(/non-JSON/);
  });

  it('throws on non-2xx responses', async () => {
    stubFetch('', 503);
    await expect(
      searchGdelt('q', { resultCount: 5, freshness: 'any' }),
    ).rejects.toThrow(/503/);
  });
});
