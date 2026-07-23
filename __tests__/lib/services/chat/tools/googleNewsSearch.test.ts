import {
  buildGoogleNewsFeedUrl,
  decodeLegacyGoogleNewsUrl,
  parseGoogleNewsRss,
  resolveGoogleNewsLink,
  searchGoogleNews,
} from '@/lib/services/chat/tools/googleNewsSearch';

import { afterEach, describe, expect, it, vi } from 'vitest';

const FEED_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>"india protests" - Google News</title>
<item>
  <title>Delhi students protest exam changes - The Hindu</title>
  <link>https://news.google.com/rss/articles/ABC123?oc=5</link>
  <pubDate>Tue, 21 Jul 2026 08:00:00 GMT</pubDate>
  <description>&lt;a href="https://news.google.com/x"&gt;Delhi students protest exam changes&lt;/a&gt;&amp;nbsp;Thousands marched in Delhi over NEET changes.</description>
  <source url="https://www.thehindu.com">The Hindu</source>
</item>
<item>
  <title><![CDATA[Farmers renew demands - Reuters]]></title>
  <link>https://news.google.com/rss/articles/DEF456?oc=5</link>
  <pubDate>Mon, 20 Jul 2026 12:00:00 GMT</pubDate>
  <description>Farmer unions announced renewed action.</description>
  <source url="https://www.reuters.com">Reuters</source>
</item>
</channel></rss>`;

/** Builds a legacy CBMi-style article id embedding `url` in protobuf-ish framing. */
function legacyArticleId(url: string): string {
  return Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22, url.length]),
    Buffer.from(url, 'ascii'),
    Buffer.from([0xd2, 0x01, 0x00]),
  ]).toString('base64url');
}

describe('parseGoogleNewsRss', () => {
  it('parses items with title, link, date, source, and snippet', () => {
    const items = parseGoogleNewsRss(FEED_FIXTURE);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'Delhi students protest exam changes',
      link: 'https://news.google.com/rss/articles/ABC123?oc=5',
      pubDate: 'Tue, 21 Jul 2026 08:00:00 GMT',
      source: 'The Hindu',
      sourceUrl: 'https://www.thehindu.com',
      snippet: expect.stringContaining('Delhi students protest exam changes'),
    });
    // CDATA + " - Source" suffix stripping
    expect(items[1].title).toBe('Farmers renew demands');
    expect(items[1].source).toBe('Reuters');
  });

  it('returns [] on garbage input', () => {
    expect(parseGoogleNewsRss('not xml')).toEqual([]);
    expect(parseGoogleNewsRss('')).toEqual([]);
  });
});

describe('decodeLegacyGoogleNewsUrl', () => {
  it('decodes an embedded publisher URL locally', () => {
    const url = 'https://www.thehindu.com/news/national/article123.ece';
    const link = `https://news.google.com/rss/articles/${legacyArticleId(url)}?oc=5`;

    expect(decodeLegacyGoogleNewsUrl(link)).toBe(url);
  });

  it('returns null when no URL is embedded (new-format ids)', () => {
    const link = `https://news.google.com/rss/articles/${Buffer.from(
      'AU_yqLPn1uL5v2',
    ).toString('base64url')}`;
    expect(decodeLegacyGoogleNewsUrl(link)).toBeNull();
  });

  it('never returns a google link as the decoded result', () => {
    const link = `https://news.google.com/rss/articles/${legacyArticleId(
      'https://news.google.com/self',
    )}`;
    expect(decodeLegacyGoogleNewsUrl(link)).toBeNull();
  });
});

describe('buildGoogleNewsFeedUrl', () => {
  it('builds the SO-format URL with hl/gl/ceid', () => {
    const url = buildGoogleNewsFeedUrl('india protests', {
      resultCount: 8,
      freshness: 'any',
    });
    expect(url).toBe(
      'https://news.google.com/rss/search?q=india+protests&hl=en-US&gl=US&ceid=US%3Aen',
    );
  });

  it('maps freshness onto the when: operator', () => {
    expect(
      buildGoogleNewsFeedUrl('x', { resultCount: 8, freshness: 'day' }),
    ).toContain('q=x+when%3A1d');
    expect(
      buildGoogleNewsFeedUrl('x', { resultCount: 8, freshness: 'month' }),
    ).toContain('when%3A30d');
  });
});

describe('searchGoogleNews', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the feed, resolves legacy links, and builds digest + citations', async () => {
    const realUrl = 'https://www.thehindu.com/article123';
    const feed = FEED_FIXTURE.replace(
      'https://news.google.com/rss/articles/ABC123?oc=5',
      `https://news.google.com/rss/articles/${legacyArticleId(realUrl)}?oc=5`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/rss/search')) {
          return new Response(feed, { status: 200 });
        }
        // New-format resolution attempts fail → google-link fallback.
        return new Response('nope', { status: 404 });
      }),
    );

    const result = await searchGoogleNews('india protests', {
      resultCount: 8,
      freshness: 'week',
    });

    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].url).toBe(realUrl);
    // Unresolvable link falls back to the google link (still clickable)…
    expect(result.citations[1].url).toContain('news.google.com');
    // …but the TRUE publisher still rides the citation for display, so
    // source diversity stays visible even with redirect links.
    expect(result.citations[1].sourceName).toBe('Reuters');
    expect(result.citations[1].sourceUrl).toBe('https://www.reuters.com');
    expect(result.citations[0].sourceName).toBe('The Hindu');
    expect(result.text).toContain('[1] Delhi students protest exam changes');
    expect(result.text).toContain('[2] Farmers renew demands');
    // Freshness rode the query
    const feedCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(feedCall)).toContain('when%3A7d');
  });

  it('returns empty result shape when the feed has no items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<rss><channel></channel></rss>', { status: 200 }),
      ),
    );

    const result = await searchGoogleNews('nothing', {
      resultCount: 8,
      freshness: 'any',
    });
    expect(result).toEqual({ text: '', citations: [] });
  });

  it('throws on feed failure (enricher degrades to knowledge answer)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 503 })),
    );

    await expect(
      searchGoogleNews('x', { resultCount: 8, freshness: 'any' }),
    ).rejects.toThrow('503');
  });
});

describe('resolveGoogleNewsLink', () => {
  it('passes non-google links through untouched', async () => {
    expect(await resolveGoogleNewsLink('https://example.com/a')).toBe(
      'https://example.com/a',
    );
  });
});
