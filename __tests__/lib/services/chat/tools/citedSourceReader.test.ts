import { readCitedSources } from '@/lib/services/chat/tools/citedSourceReader';
import { resolveLinksSerially } from '@/lib/services/chat/tools/googleNewsSearch';
import { extractReadableContent } from '@/lib/services/workflows/shared/articleExtraction';

import { fetchPublicUrl } from '@/lib/utils/server/net/publicUrlGuard';

import { Citation } from '@/types/rag';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/server/net/publicUrlGuard', () => ({
  fetchPublicUrl: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/articleExtraction', () => ({
  extractReadableContent: vi.fn(),
}));
vi.mock('@/lib/services/chat/tools/googleNewsSearch', () => ({
  resolveLinksSerially: vi.fn(async (links: string[]) => links),
}));

const citation = (n: number, overrides: Partial<Citation> = {}): Citation => ({
  number: n,
  title: `Article ${n}`,
  url: `https://publisher-${n}.example/story-${n}`,
  date: '2026-07-21',
  sourceName: `Publisher ${n}`,
  ...overrides,
});

function mockPageOk(text = 'Body prose. '.repeat(40)) {
  vi.mocked(fetchPublicUrl).mockImplementation(async (url: string) => ({
    response: {
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => new TextEncoder().encode('<html/>').buffer,
    } as unknown as Response,
    resolvedUrl: url,
  }));
  vi.mocked(extractReadableContent).mockResolvedValue({
    text,
    title: 'Extracted title',
    siteName: 'site',
    extractedVia: 'readability',
    truncated: false,
  });
}

describe('readCitedSources', () => {
  beforeEach(() => {
    vi.mocked(fetchPublicUrl).mockReset();
    vi.mocked(extractReadableContent).mockReset();
    vi.mocked(resolveLinksSerially).mockReset();
    vi.mocked(resolveLinksSerially).mockImplementation(
      async (links: string[]) => links,
    );
  });

  it('fetches cited articles and builds a numbered digest', async () => {
    mockPageOk('The full article body with real detail.');

    const digest = await readCitedSources([citation(1), citation(2)]);

    expect(digest.fetchedCount).toBe(2);
    expect(digest.attemptedCount).toBe(2);
    expect(digest.text).toContain('[1] Article 1 — Publisher 1');
    expect(digest.text).toContain('[2] Article 2 — Publisher 2');
    expect(digest.text).toContain('The full article body');
    expect(digest.citations.map((c) => c.number)).toEqual([1, 2]);
  });

  it('caps article text length in the digest', async () => {
    mockPageOk('x'.repeat(10_000));

    const digest = await readCitedSources([citation(1)]);
    expect(digest.text).toContain('[…article truncated]');
    expect(digest.text.length).toBeLessThan(4_000);
  });

  it('tolerates per-article failures and reports only readable ones', async () => {
    mockPageOk();
    vi.mocked(fetchPublicUrl).mockRejectedValueOnce(new Error('bot wall'));

    const digest = await readCitedSources([citation(1), citation(2)]);
    expect(digest.fetchedCount).toBe(1);
    expect(digest.attemptedCount).toBe(2);
    // Renumbered contiguously: the surviving article is [1].
    expect(digest.citations).toHaveLength(1);
    expect(digest.citations[0].number).toBe(1);
    expect(digest.citations[0].title).toBe('Article 2');
  });

  it('returns an empty digest when nothing is readable', async () => {
    vi.mocked(fetchPublicUrl).mockRejectedValue(new Error('down'));

    const digest = await readCitedSources([citation(1)]);
    expect(digest).toMatchObject({
      text: '',
      citations: [],
      fetchedCount: 0,
      attemptedCount: 1,
    });
  });

  it('drops unresolvable google links but fetches resolver upgrades', async () => {
    mockPageOk();
    const resolvable = citation(1, {
      url: 'https://news.google.com/rss/articles/RESOLVABLE',
    });
    const stuck = citation(2, {
      url: 'https://news.google.com/rss/articles/STUCK',
    });
    vi.mocked(resolveLinksSerially).mockResolvedValue([
      'https://real-publisher.example/story',
      'https://news.google.com/rss/articles/STUCK',
    ]);

    const digest = await readCitedSources([resolvable, stuck, citation(3)]);

    expect(digest.attemptedCount).toBe(2);
    expect(vi.mocked(fetchPublicUrl).mock.calls.map((c) => c[0])).toEqual([
      'https://real-publisher.example/story',
      'https://publisher-3.example/story-3',
    ]);
  });

  it('dedupes by URL and caps at five articles', async () => {
    mockPageOk();
    const citations = [
      citation(1),
      citation(1),
      ...[2, 3, 4, 5, 6, 7].map((n) => citation(n)),
    ];

    const digest = await readCitedSources(citations);
    expect(digest.attemptedCount).toBe(5);
    expect(vi.mocked(fetchPublicUrl)).toHaveBeenCalledTimes(5);
  });

  it('skips non-html content types', async () => {
    vi.mocked(fetchPublicUrl).mockResolvedValue({
      response: {
        ok: true,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response,
      resolvedUrl: 'https://publisher-1.example/story-1',
    });

    const digest = await readCitedSources([citation(1)]);
    expect(digest.fetchedCount).toBe(0);
    expect(extractReadableContent).not.toHaveBeenCalled();
  });
});
