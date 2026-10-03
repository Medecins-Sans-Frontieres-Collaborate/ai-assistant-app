import {
  __resetSearxngCapabilitiesForTests,
  getSearxngCapabilities,
  parseSearxngConfig,
  webEnginesOf,
} from '@/lib/services/chat/tools/searxngCapabilities';

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

const config = {
  categories: ['general', 'news', 'web'],
  engines: [
    { name: 'qwant', categories: ['general', 'web'], enabled: true },
    { name: 'bing', categories: ['general', 'web'], enabled: true },
    { name: 'wikipedia', categories: ['general'], enabled: true },
    { name: 'google', categories: ['general', 'web'], enabled: false },
    { name: 'bing news', categories: ['news'], enabled: true },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseSearxngConfig', () => {
  it('reads categories and enabled engines with their categories', () => {
    const parsed = parseSearxngConfig(config)!;
    expect([...parsed.categories].sort()).toEqual(['general', 'news', 'web']);
    expect(parsed.engineCategories.get('qwant')).toEqual(['general', 'web']);
    // Disabled engines never count.
    expect(parsed.engineCategories.has('google')).toBe(false);
    expect([...webEnginesOf(parsed)].sort()).toEqual(['bing', 'qwant']);
  });

  it('rejects shapes without engines', () => {
    expect(parseSearxngConfig({})).toBeNull();
    expect(parseSearxngConfig({ engines: 'nope' })).toBeNull();
    expect(webEnginesOf(null).size).toBe(0);
  });
});

describe('getSearxngCapabilities', () => {
  const fetchMock = vi.fn();
  const priorUrl = env.SEARXNG_URL;
  const priorKey = env.SEARXNG_API_KEY;

  beforeEach(() => {
    __resetSearxngCapabilitiesForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    (env as { SEARXNG_URL?: string }).SEARXNG_URL = 'https://searx.internal';
    (env as { SEARXNG_API_KEY?: string }).SEARXNG_API_KEY = KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  afterAll(() => {
    (env as { SEARXNG_URL?: string }).SEARXNG_URL = priorUrl;
    (env as { SEARXNG_API_KEY?: string }).SEARXNG_API_KEY = priorKey;
  });

  it('fetches /config with the shared key once and caches it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(config));

    const first = await getSearxngCapabilities();
    const second = await getSearxngCapabilities();

    expect(first?.categories.has('web')).toBe(true);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://searx.internal/config');
    expect(init.headers['X-Search-Key']).toBe(KEY);
    expect(init.redirect).toBe('error');
  });

  it('is null — and not retried for a while — when the proxy does not admit /config', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));

    expect(await getSearxngCapabilities()).toBeNull();
    expect(await getSearxngCapabilities()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is null without an instance configured, without fetching', async () => {
    (env as { SEARXNG_URL?: string }).SEARXNG_URL = undefined;
    expect(await getSearxngCapabilities()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(config));
    await Promise.all([getSearxngCapabilities(), getSearxngCapabilities()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
