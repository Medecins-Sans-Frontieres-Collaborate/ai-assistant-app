import {
  buildSourceCards,
  groupSourceCardsByOrigin,
} from '@/lib/utils/app/citationDisplay';

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

describe('source origins', () => {
  const page = (number: number, origin?: Citation['origin']): Citation => ({
    title: `Source ${number}`,
    date: '',
    url: `https://example.org/${number}`,
    number,
    ...(origin ? { origin } : {}),
  });

  it('never merges a web page into a document card that shares its title', () => {
    const cards = buildSourceCards([
      { ...page(1, 'knowledge'), title: 'Overtime rules' },
      { ...page(2, 'web'), title: 'Overtime rules' },
    ]);

    expect(cards.map((card) => card.origin)).toEqual(['knowledge', 'web']);
  });

  it('still merges chunks of the same document', () => {
    const cards = buildSourceCards([
      { ...page(1, 'knowledge'), url: URL },
      { ...page(2, 'knowledge'), url: URL },
    ]);

    expect(cards).toHaveLength(1);
  });

  it('lists documents before web pages, keeping order within each', () => {
    const groups = groupSourceCardsByOrigin(
      buildSourceCards([
        page(1, 'web'),
        page(2, 'knowledge'),
        page(3, 'web'),
        page(4, 'knowledge'),
      ]),
    );

    expect(
      groups.map((group) => [group.origin, group.cards.map((c) => c.number)]),
    ).toEqual([
      ['knowledge', [2, 4]],
      ['web', [1, 3]],
    ]);
  });

  it('keeps cards stored without an origin in a last, unlabelled group', () => {
    const groups = groupSourceCardsByOrigin(
      buildSourceCards([page(1), page(2, 'web')]),
    );

    expect(groups.map((group) => group.origin)).toEqual(['web', undefined]);
  });

  it('returns no empty groups', () => {
    expect(groupSourceCardsByOrigin([])).toEqual([]);
    expect(
      groupSourceCardsByOrigin(buildSourceCards([page(1, 'web')])),
    ).toHaveLength(1);
  });
});
