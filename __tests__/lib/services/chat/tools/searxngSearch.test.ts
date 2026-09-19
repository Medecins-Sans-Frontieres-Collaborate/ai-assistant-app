import {
  buildSearxngUrl,
  isLikelyHubPage,
  isSearxngConfigured,
  parseSearxngResponse,
  planSearxngCategories,
  preferArticles,
  searchSearxng,
} from '@/lib/services/chat/tools/searxngSearch';

import { env } from '@/config/environment';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const KEY = 'k'.repeat(48);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function result(n: number, extra: Record<string, unknown> = {}) {
  return {
    url: `https://site${n}.example/page`,
    title: `Result ${n}`,
    content: `Snippet ${n}`,
    ...extra,
  };
}

describe('planSearxngCategories', () => {
  it('answers a surface general lookup from the general engines alone', () => {
    expect(planSearxngCategories({ freshness: 'any', deep: false })).toEqual([
      'general',
    ]);
  });

  it('leads with news when the question is recency-driven', () => {
    expect(planSearxngCategories({ freshness: 'day', deep: false })).toEqual([
      'news',
      'general',
    ]);
  });

  it('adds a breadth leg for deep searches', () => {
    expect(
      planSearxngCategories({
        category: 'science',
        freshness: 'any',
        deep: true,
      }),
    ).toEqual(['science', 'general']);
    expect(
      planSearxngCategories({
        category: 'general',
        freshness: 'any',
        deep: true,
      }),
    ).toEqual(['general', 'news']);
  });

  it('pairs the datasets-only humanitarian category with news', () => {
    expect(
      planSearxngCategories({
        category: 'humanitarian',
        freshness: 'any',
        deep: false,
      }),
    ).toEqual(['humanitarian', 'news']);
  });
});

describe('buildSearxngUrl', () => {
  it('targets /search with the JSON format, category and auto language', () => {
    const url = new URL(
      buildSearxngUrl(
        'https://searx.internal',
        'cholera vaccine',
        'news',
        'week',
      ),
    );
    expect(url.origin + url.pathname).toBe('https://searx.internal/search');
    expect(url.searchParams.get('q')).toBe('cholera vaccine');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('categories')).toBe('news');
    expect(url.searchParams.get('language')).toBe('auto');
    expect(url.searchParams.get('time_range')).toBe('week');
  });

  it("omits time_range for 'any' and for categories whose engines lack it", () => {
    expect(
      new URL(
        buildSearxngUrl('https://searx.internal', 'q', 'general', 'any'),
      ).searchParams.has('time_range'),
    ).toBe(false);
    // An engine without time-range support is SKIPPED when the parameter
    // is present — it would silently empty a science search.
    expect(
      new URL(
        buildSearxngUrl('https://searx.internal', 'q', 'science', 'day'),
      ).searchParams.has('time_range'),
    ).toBe(false);
  });
});

describe('isLikelyHubPage', () => {
  it('flags homepages, section fronts, tag listings and index pages', () => {
    for (const url of [
      'https://www.indiatoday.in/',
      'https://www.bbc.com/news/world/asia/india',
      'https://economictimes.indiatimes.com/news/politics',
      'https://www.ndtv.com/latest',
      'https://www.hindustantimes.com/india-news',
      'https://telanganatoday.com/tag/semicon-india-2026',
      'https://pib.gov.in/indexd.aspx?reg=3&lang=1',
      'https://werindia.com/elections2026',
    ]) {
      expect(isLikelyHubPage(url), url).toBe(true);
    }
  });

  it('recognises stories by a multi-word slug or a long numeric id', () => {
    for (const url of [
      'https://www.bbc.com/news/articles/c4g5k2xq9d1o-india-floods-displace-thousands',
      'https://www.reuters.com/world/india/india-cuts-fuel-tax-2026-09-17/',
      'https://www.ndtv.com/india-news/monsoon-floods-assam-death-toll-rises-7654321',
      'https://www.thehindu.com/news/national/article70012345.ece',
      'https://example.com/2026/09/17/parliament-passes-data-bill.html',
    ]) {
      expect(isLikelyHubPage(url), url).toBe(false);
    }
  });

  it('never flags an unparseable URL', () => {
    expect(isLikelyHubPage('not a url')).toBe(false);
  });
});

describe('preferArticles', () => {
  const entry = (url: string) => ({ title: url, url, date: '' });
  const hub = entry('https://www.ndtv.com/latest');
  const stories = [1, 2, 3].map((n) =>
    entry(`https://site.example/news/floods-displace-thousands-${n}`),
  );

  it('drops hub pages once enough stories exist', () => {
    expect(preferArticles([hub, ...stories])).toEqual(stories);
  });

  it('keeps hub pages, demoted, when stories are scarce', () => {
    expect(preferArticles([hub, stories[0]])).toEqual([stories[0], hub]);
  });
});

describe('parseSearxngResponse', () => {
  it('maps results to entries with publisher domain, ISO date and snippet', () => {
    const { entries } = parseSearxngResponse(
      {
        results: [
          result(1, {
            url: 'https://www.reuters.com/world/a',
            publishedDate: '2026-09-17T08:00:00',
          }),
        ],
      },
      8,
    );
    expect(entries).toEqual([
      {
        title: 'Result 1',
        url: 'https://www.reuters.com/world/a',
        date: new Date('2026-09-17T08:00:00').toISOString(),
        sourceName: 'reuters.com',
        sourceUrl: 'https://reuters.com',
        snippet: 'Snippet 1',
      },
    ]);
  });

  it('drops non-http results, untitled results and duplicate URLs, and caps', () => {
    const { entries } = parseSearxngResponse(
      {
        results: [
          result(1),
          result(1),
          { url: 'javascript:alert(1)', title: 'bad' },
          { url: 'https://untitled.example', title: '  ' },
          result(2),
          result(3),
        ],
      },
      2,
    );
    expect(entries.map((e) => e.url)).toEqual([
      'https://site1.example/page',
      'https://site2.example/page',
    ]);
  });

  it('leaves the date empty when absent or unparseable and clips long abstracts', () => {
    const { entries } = parseSearxngResponse(
      {
        results: [
          result(1, { publishedDate: 'soon', content: 'x'.repeat(2000) }),
        ],
      },
      8,
    );
    expect(entries[0].date).toBe('');
    expect(entries[0].snippet!.length).toBeLessThanOrEqual(700);
  });

  it('leads with a citable infobox and surfaces instant answers in both shapes', () => {
    const outcome = parseSearxngResponse(
      {
        infoboxes: [
          {
            infobox: 'Cholera',
            id: 'https://en.wikipedia.org/wiki/Cholera',
            content: 'An infection of the small intestine.',
          },
        ],
        results: [result(1)],
        answers: ['1 EUR = 1.1 USD', { answer: 'object-shaped answer' }],
      },
      8,
    );
    expect(outcome.entries[0]).toMatchObject({
      title: 'Cholera',
      url: 'https://en.wikipedia.org/wiki/Cholera',
    });
    expect(outcome.answers).toEqual([
      '1 EUR = 1.1 USD',
      'object-shaped answer',
    ]);
  });

  it('tolerates a malformed body', () => {
    expect(parseSearxngResponse(null, 8)).toEqual({ entries: [], answers: [] });
    expect(parseSearxngResponse({ results: 'nope' }, 8).entries).toEqual([]);
  });
});

describe('searchSearxng', () => {
  const prior = { url: env.SEARXNG_URL, key: env.SEARXNG_API_KEY };
  const fetchMock = vi.fn();

  beforeEach(() => {
    (env as any).SEARXNG_URL = 'https://searx.internal';
    (env as any).SEARXNG_API_KEY = KEY;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    (env as any).SEARXNG_URL = prior.url;
    (env as any).SEARXNG_API_KEY = prior.key;
  });

  it('reports configuration from both env values', () => {
    expect(isSearxngConfigured()).toBe(true);
    (env as any).SEARXNG_API_KEY = undefined;
    expect(isSearxngConfigured()).toBe(false);
  });

  it('throws when unconfigured, without touching the network', async () => {
    (env as any).SEARXNG_URL = undefined;
    await expect(
      searchSearxng(['q'], { resultCount: 8, freshness: 'any' }),
    ).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the shared secret in X-Search-Key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [result(1)] }));

    const outcome = await searchSearxng(['cholera outbreak'], {
      resultCount: 8,
      freshness: 'any',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://searx.internal/search?');
    expect(init.headers['X-Search-Key']).toBe(KEY);
    expect(outcome.entries).toHaveLength(1);
  });

  it('retries exactly once on 401 (key-rotation window) and then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ results: [result(1)] }));

    const pending = searchSearxng(['q'], { resultCount: 8, freshness: 'any' });
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.entries).toHaveLength(1);
  });

  it('gives up after the second 401', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));

    const pending = searchSearxng(['q'], { resultCount: 8, freshness: 'any' });
    const assertion = expect(pending).rejects.toThrow(/401/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 502 }));
    await expect(
      searchSearxng(['q'], { resultCount: 8, freshness: 'any' }),
    ).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never puts the key in an error message or a log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));

    const error = await searchSearxng(['q'], {
      resultCount: 8,
      freshness: 'any',
    }).catch((e: Error) => e);

    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect((error as Error).message).not.toContain(KEY);
    expect(logged).not.toContain(KEY);
  });

  it('interleaves category legs for a deep search and survives one failing', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const category = new URL(url).searchParams.get('categories');
      if (category === 'news') return new Response('', { status: 500 });
      return jsonResponse({ results: [result(1), result(2)] });
    });

    const outcome = await searchSearxng(['q'], {
      resultCount: 8,
      freshness: 'any',
      deep: true,
    });

    const categories = fetchMock.mock.calls.map(([url]) =>
      new URL(url).searchParams.get('categories'),
    );
    expect(categories.sort()).toEqual(['general', 'news']);
    expect(outcome.entries.map((e) => e.title)).toEqual([
      'Result 1',
      'Result 2',
    ]);
  });

  it('runs one leg per query on the primary category for a fan-out, capped at 5', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const q = new URL(url).searchParams.get('q');
      return jsonResponse({
        results: [{ url: `https://x.example/${q}`, title: `About ${q}` }],
      });
    });

    const outcome = await searchSearxng(['a', 'b', 'c', 'd', 'e', 'f'], {
      resultCount: 8,
      freshness: 'any',
      category: 'science',
      deep: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get('categories')).toBe('science');
    }
    expect(outcome.entries).toHaveLength(5);
  });

  it('keeps stories and sheds front pages for a current-events search', async () => {
    const story = (n: number) => ({
      url: `https://paper.example/india/floods-displace-thousands-${n}`,
      title: `Story ${n}`,
    });
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).searchParams.get('categories') === 'general'
        ? jsonResponse({
            results: [
              { url: 'https://www.indiatoday.in/', title: 'Latest News' },
              { url: 'https://www.ndtv.com/latest', title: 'Big headlines' },
              story(9),
            ],
          })
        : jsonResponse({ results: [story(1), story(2), story(3)] }),
    );

    const outcome = await searchSearxng(['India'], {
      resultCount: 8,
      freshness: 'week',
      category: 'general',
    });

    expect(outcome.entries.map((e) => e.title).sort()).toEqual([
      'Story 1',
      'Story 2',
      'Story 3',
      'Story 9',
    ]);
  });

  it('leaves reference pages alone outside current-events searches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { url: 'https://en.wikipedia.org/wiki/Cholera', title: 'Cholera' },
          result(1),
          result(2),
          result(3),
        ],
      }),
    );

    const outcome = await searchSearxng(['cholera'], {
      resultCount: 8,
      freshness: 'any',
    });

    expect(outcome.entries[0].url).toBe(
      'https://en.wikipedia.org/wiki/Cholera',
    );
    expect(outcome.entries).toHaveLength(4);
  });

  it('retries without the recency window when it comes back empty', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).searchParams.has('time_range')
        ? jsonResponse({ results: [] })
        : jsonResponse({ results: [result(1)] }),
    );

    const outcome = await searchSearxng(['q'], {
      resultCount: 8,
      freshness: 'month',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.entries).toHaveLength(1);
  });

  it('reports a timeout as such', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    vi.useFakeTimers();

    const pending = searchSearxng(['q'], { resultCount: 8, freshness: 'any' });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
  });
});
