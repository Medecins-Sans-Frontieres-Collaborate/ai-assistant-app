import { buildSourceCards } from '@/lib/utils/app/citationDisplay';

import { Citation } from '@/types/rag';

import { describe, expect, it } from 'vitest';

const URL = 'https://contoso.sharepoint.com/handbook.pdf';

function chunkCitation(
  number: number,
  quote: string,
  locator?: string,
): Citation {
  return {
    title: 'Employee Handbook',
    date: '2026-01-01',
    url: URL,
    number,
    quote,
    ...(locator ? { locator } : {}),
  };
}

describe('buildSourceCards', () => {
  it('lists each cited number as its own evidence row with ITS locator', () => {
    const citations = [
      chunkCitation(1, 'personal days quote', 'pp. 61–63'),
      chunkCitation(2, 'uncited chunk quote', 'p. 12'),
      chunkCitation(3, 'religious observance quote', 'p. 68'),
    ];
    const cards = buildSourceCards(citations, [1, 3]);

    expect(cards).toHaveLength(1);
    expect(cards[0].evidence).toEqual([
      { number: 1, quote: 'personal days quote', locator: 'pp. 61–63' },
      { number: 3, quote: 'religious observance quote', locator: 'p. 68' },
    ]);
    // No card-level quote/locator — evidence rows own them; the uncited
    // chunk's pages must NOT appear anywhere.
    expect(cards[0].quote).toBeUndefined();
    expect(cards[0].locator).toBeUndefined();
  });

  it('dedupes identical quotes across cited chunks', () => {
    const citations = [
      chunkCitation(1, 'same quote', 'p. 1'),
      chunkCitation(2, 'same quote', 'p. 2'),
    ];
    const cards = buildSourceCards(citations, [1, 2]);
    expect(cards[0].evidence).toHaveLength(1);
  });

  it('falls back to the legacy merge when nothing was cited', () => {
    const citations = [
      chunkCitation(1, 'q1', 'p. 1'),
      chunkCitation(2, 'q2', 'p. 2'),
    ];
    const cards = buildSourceCards(citations, []);
    expect(cards[0].evidence).toBeUndefined();
    expect(cards[0].quote).toBe('q1');
    expect(cards[0].locator).toBe('p. 1, p. 2');
  });

  it('keeps distinct documents as distinct cards', () => {
    const cards = buildSourceCards(
      [
        chunkCitation(1, 'q1', 'p. 1'),
        {
          ...chunkCitation(2, 'q2'),
          url: 'https://x/other.pdf',
          title: 'Other Policy',
        },
      ],
      [1, 2],
    );
    expect(cards).toHaveLength(2);
  });

  it('drops citations without a URL', () => {
    const cards = buildSourceCards(
      [{ ...chunkCitation(1, 'q'), url: '' }],
      [1],
    );
    expect(cards).toHaveLength(0);
  });
});
