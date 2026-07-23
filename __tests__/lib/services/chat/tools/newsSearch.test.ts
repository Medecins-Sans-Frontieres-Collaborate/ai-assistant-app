import { searchGdelt } from '@/lib/services/chat/tools/gdeltSearch';
import { fetchGoogleNewsItems } from '@/lib/services/chat/tools/googleNewsSearch';
import {
  searchNewsFanOut,
  searchNewsParallel,
} from '@/lib/services/chat/tools/newsSearch';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/chat/tools/gdeltSearch', () => ({
  searchGdelt: vi.fn(),
}));
vi.mock(
  '@/lib/services/chat/tools/googleNewsSearch',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/chat/tools/googleNewsSearch')
      >();
    return { ...actual, fetchGoogleNewsItems: vi.fn() };
  },
);

const gdeltArticle = (n: number, overrides: Record<string, string> = {}) => ({
  title: `GDELT story ${n}`,
  url: `https://gdelt-pub-${n}.example/story`,
  date: '2026-07-21T08:00:00Z',
  domain: `www.gdelt-pub-${n}.example`,
  ...overrides,
});

const googleItem = (n: number, overrides: Record<string, string> = {}) => ({
  title: `Google story ${n}`,
  link: `https://news.google.com/rss/articles/OPAQUE${n}`,
  pubDate: 'Tue, 21 Jul 2026 09:00:00 GMT',
  source: `Publisher ${n}`,
  sourceUrl: `https://publisher-${n}.example`,
  snippet: `Snippet for story ${n}`,
  ...overrides,
});

const OPTIONS = { resultCount: 8, freshness: 'any' } as const;

describe('searchNewsParallel', () => {
  beforeEach(() => {
    vi.mocked(searchGdelt).mockReset();
    vi.mocked(fetchGoogleNewsItems).mockReset();
  });

  it('interleaves both providers, gdelt first, with unified numbering', async () => {
    vi.mocked(searchGdelt).mockResolvedValue([
      gdeltArticle(1),
      gdeltArticle(2),
    ]);
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue([
      googleItem(1),
      googleItem(2),
    ]);

    const result = await searchNewsParallel('india protests', OPTIONS);

    expect(result.providersUsed).toEqual(['gdelt', 'google-news']);
    expect(result.citations.map((c) => c.title)).toEqual([
      'GDELT story 1',
      'Google story 1',
      'GDELT story 2',
      'Google story 2',
    ]);
    expect(result.citations.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    // GDELT citations carry real publisher URLs + derived source fields.
    expect(result.citations[0]).toMatchObject({
      url: 'https://gdelt-pub-1.example/story',
      sourceName: 'gdelt-pub-1.example',
      sourceUrl: 'https://gdelt-pub-1.example',
    });
    // Google citations keep publisher attribution for display.
    expect(result.citations[1]).toMatchObject({
      sourceName: 'Publisher 1',
      sourceUrl: 'https://publisher-1.example',
    });
    // Digest cites by merged number and keeps google snippets.
    expect(result.text).toContain('[2] Google story 1');
    expect(result.text).toContain('Snippet for story 1');
  });

  it('deduplicates the same story appearing in both feeds', async () => {
    vi.mocked(searchGdelt).mockResolvedValue([
      gdeltArticle(1, { title: 'Protests spread: what to know' }),
    ]);
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue([
      googleItem(1, { title: 'Protests spread — what to know!' }),
      googleItem(2),
    ]);

    const result = await searchNewsParallel('q', OPTIONS);
    expect(result.citations.map((c) => c.title)).toEqual([
      'Protests spread: what to know',
      'Google story 2',
    ]);
  });

  it('survives a GDELT failure on Google News results alone', async () => {
    vi.mocked(searchGdelt).mockRejectedValue(new Error('GDELT returned 503'));
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue([googleItem(1)]);

    const result = await searchNewsParallel('q', OPTIONS);
    expect(result.providersUsed).toEqual(['google-news']);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].title).toBe('Google story 1');
  });

  it('survives a Google News failure on GDELT results alone', async () => {
    vi.mocked(searchGdelt).mockResolvedValue([gdeltArticle(1)]);
    vi.mocked(fetchGoogleNewsItems).mockRejectedValue(
      new Error('Google News feed returned 429'),
    );

    const result = await searchNewsParallel('q', OPTIONS);
    expect(result.providersUsed).toEqual(['gdelt']);
    expect(result.citations).toHaveLength(1);
  });

  it('throws only when ALL providers error', async () => {
    vi.mocked(searchGdelt).mockRejectedValue(new Error('down'));
    vi.mocked(fetchGoogleNewsItems).mockRejectedValue(new Error('also down'));

    await expect(searchNewsParallel('q', OPTIONS)).rejects.toThrow(
      /All news providers failed.*gdelt: down.*google-news: also down/,
    );
  });

  it('returns the empty-result shape when feeds succeed but find nothing', async () => {
    vi.mocked(searchGdelt).mockResolvedValue([]);
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue([]);

    const result = await searchNewsParallel('q', OPTIONS);
    expect(result).toEqual({ text: '', citations: [], providersUsed: [] });
  });

  it('caps merged results at resultCount', async () => {
    vi.mocked(searchGdelt).mockResolvedValue(
      [1, 2, 3].map((n) => gdeltArticle(n)),
    );
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue(
      [1, 2, 3].map((n) => googleItem(n)),
    );

    const result = await searchNewsParallel('q', {
      resultCount: 3,
      freshness: 'any',
    });
    expect(result.citations).toHaveLength(3);
    expect(result.citations.map((c) => c.title)).toEqual([
      'GDELT story 1',
      'Google story 1',
      'GDELT story 2',
    ]);
  });

  it('queries only GDELT when scoped to a single source', async () => {
    vi.mocked(searchGdelt).mockResolvedValue([gdeltArticle(1)]);

    const result = await searchNewsParallel('q', OPTIONS, {
      sources: ['gdelt'],
    });
    expect(fetchGoogleNewsItems).not.toHaveBeenCalled();
    expect(result.providersUsed).toEqual(['gdelt']);
  });

  describe('surface mode (deep: false)', () => {
    it('answers from Google News alone without touching GDELT', async () => {
      vi.mocked(fetchGoogleNewsItems).mockResolvedValue([googleItem(1)]);

      const result = await searchNewsParallel('q', OPTIONS, { deep: false });
      expect(searchGdelt).not.toHaveBeenCalled();
      expect(result.providersUsed).toEqual(['google-news']);
    });

    it('falls back to GDELT when Google News fails', async () => {
      vi.mocked(fetchGoogleNewsItems).mockRejectedValue(new Error('429'));
      vi.mocked(searchGdelt).mockResolvedValue([gdeltArticle(1)]);

      const result = await searchNewsParallel('q', OPTIONS, { deep: false });
      expect(result.providersUsed).toEqual(['gdelt']);
      expect(result.citations[0].title).toBe('GDELT story 1');
    });

    it('falls back to GDELT when Google News finds nothing', async () => {
      vi.mocked(fetchGoogleNewsItems).mockResolvedValue([]);
      vi.mocked(searchGdelt).mockResolvedValue([gdeltArticle(1)]);

      const result = await searchNewsParallel('q', OPTIONS, { deep: false });
      expect(result.providersUsed).toEqual(['gdelt']);
    });

    it('throws when the fast tier AND the fallback both error', async () => {
      vi.mocked(fetchGoogleNewsItems).mockRejectedValue(new Error('down'));
      vi.mocked(searchGdelt).mockRejectedValue(new Error('also down'));

      await expect(
        searchNewsParallel('q', OPTIONS, { deep: false }),
      ).rejects.toThrow(/All news providers failed/);
    });

    it('returns empty (no throw) when Google finds nothing and GDELT errors', async () => {
      vi.mocked(fetchGoogleNewsItems).mockResolvedValue([]);
      vi.mocked(searchGdelt).mockRejectedValue(new Error('rate limited'));

      const result = await searchNewsParallel('q', OPTIONS, { deep: false });
      expect(result).toEqual({ text: '', citations: [], providersUsed: [] });
    });
  });
});

describe('searchNewsFanOut', () => {
  beforeEach(() => {
    vi.mocked(searchGdelt).mockReset();
    vi.mocked(fetchGoogleNewsItems).mockReset();
  });

  it('runs one Google News leg per query, never GDELT, and merges with dedupe', async () => {
    vi.mocked(fetchGoogleNewsItems)
      .mockResolvedValueOnce([googleItem(1), googleItem(2)])
      .mockResolvedValueOnce([googleItem(3), googleItem(2)]);

    const result = await searchNewsFanOut(
      ['france strikes', 'germany rail dispute'],
      OPTIONS,
    );

    expect(searchGdelt).not.toHaveBeenCalled();
    expect(fetchGoogleNewsItems).toHaveBeenCalledTimes(2);
    expect(fetchGoogleNewsItems).toHaveBeenCalledWith(
      'france strikes',
      expect.anything(),
    );
    expect(fetchGoogleNewsItems).toHaveBeenCalledWith(
      'germany rail dispute',
      expect.anything(),
    );
    // Interleaved across the query lists, duplicate story kept once.
    expect(result.citations.map((c) => c.title)).toEqual([
      'Google story 1',
      'Google story 3',
      'Google story 2',
    ]);
    expect(result.providersUsed).toEqual(['google-news']);
    // Digest names every query.
    expect(result.text).toContain('"france strikes"; "germany rail dispute"');
  });

  it('splits the result budget across queries with a dedupe buffer', async () => {
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue([googleItem(1)]);

    await searchNewsFanOut(['a', 'b', 'c'], {
      resultCount: 9,
      freshness: 'any',
    });
    expect(fetchGoogleNewsItems).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ resultCount: 5 }),
    );
  });

  it('survives individual query failures', async () => {
    vi.mocked(fetchGoogleNewsItems)
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce([googleItem(1)]);

    const result = await searchNewsFanOut(['a', 'b'], OPTIONS);
    expect(result.citations).toHaveLength(1);
  });

  it('throws only when every query errors', async () => {
    vi.mocked(fetchGoogleNewsItems).mockRejectedValue(new Error('down'));

    await expect(searchNewsFanOut(['a', 'b'], OPTIONS)).rejects.toThrow(
      /All fan-out queries failed/,
    );
  });

  it('hard-caps at five queries', async () => {
    vi.mocked(fetchGoogleNewsItems).mockResolvedValue([googleItem(1)]);

    await searchNewsFanOut(['a', 'b', 'c', 'd', 'e', 'f', 'g'], OPTIONS);
    expect(fetchGoogleNewsItems).toHaveBeenCalledTimes(5);
  });
});
