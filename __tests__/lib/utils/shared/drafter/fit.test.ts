import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { countText } from '@/lib/utils/shared/drafter/core/counting';
import {
  dropTrailingHashtags,
  fitByMoving,
  overages,
} from '@/lib/utils/shared/drafter/core/fit';
import { protectedRanges } from '@/lib/utils/shared/drafter/core/revisions';
import { OverflowOptions } from '@/lib/utils/shared/drafter/core/segments';

import { Brief, Segment } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const seg = (id: string, text: string): Segment => ({
  id,
  text,
  usedItemIds: [],
});

function minter() {
  let n = 0;
  return () => `n${(n += 1)}`;
}

const X: OverflowOptions = {
  rule: 'x-weighted',
  limit: 280,
  numbered: true,
  maxSegments: 25,
};

describe('counting the way X counts', () => {
  it('counts a bare domain as a link, which is what X does', () => {
    expect(countText('x-weighted', 'example.org/report')).toBe(23);
    expect(countText('x-weighted', 'Read msf.org today')).toBe(5 + 23 + 6);
  });

  it('does not mistake abbreviations, decimals or handles for links', () => {
    for (const text of [
      'e.g. this',
      'i.e. that',
      'the U.S.A. said',
      '3.5 million',
      'No.5',
      '@msf.intl',
    ]) {
      expect(countText('x-weighted', text)).toBe(text.length);
    }
  });

  it('counts every emoji as 2: flags, keycaps and joined families too', () => {
    for (const emoji of ['🇸🇸', '1️⃣', '👩‍👩‍👧', '👍🏽', '❤️']) {
      expect(countText('x-weighted', emoji)).toBe(2);
    }
  });

  it('stays fast on a long hostile input', () => {
    const hostile = `${'a'.repeat(3000)}.${'-a'.repeat(1500)}`;
    const started = Date.now();
    countText('x-weighted', hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('fitByMoving', () => {
  it('keeps moving until EVERY post fits, not just the first', () => {
    const long = [seg('a', 'Sentence one is here. '.repeat(40).trim())];
    const report = fitByMoving(long, X, minter());
    expect(report.fits).toBe(true);
    expect(report.segments.length).toBeGreaterThan(2);
    expect(overages(report.segments, X)).toEqual({});
    // Nothing was reworded or lost.
    expect(report.segments.map((s) => s.text).join(' ')).toBe(long[0].text);
  });

  it('stops at the channel’s maximum and says what is still over', () => {
    const report = fitByMoving(
      [seg('a', 'Sentence one is here. '.repeat(40).trim())],
      { ...X, maxSegments: 2 },
      minter(),
    );
    expect(report.segments).toHaveLength(2);
    expect(report.fits).toBe(false);
    expect(Object.values(report.remaining)[0]).toBeGreaterThan(0);
  });

  it('changes nothing on a single-post channel, and reports it honestly', () => {
    const one = [seg('a', 'word '.repeat(100).trim())];
    const report = fitByMoving(
      one,
      { rule: 'graphemes', limit: 50, numbered: false, maxSegments: 1 },
      minter(),
    );
    expect(report.segments).toBe(one);
    expect(report.fits).toBe(false);
  });

  it('never cuts through a quotation from the brief: it moves whole', () => {
    const quote =
      'We had no clean water for eleven days and nobody came to help us at all';
    const brief: Brief = {
      ...emptyBrief(),
      items: [
        {
          id: 'q1',
          kind: 'quote',
          text: quote,
          provenance: [],
          verified: 'verbatim',
          decision: 'included',
        },
      ],
    };
    const text = `${'Opening words here. '.repeat(11)}A nurse said “${quote}” and then left.`;
    const report = fitByMoving(
      [seg('a', text)],
      { ...X, protectedRanges: (s) => protectedRanges(s, brief) },
      minter(),
    );
    expect(report.fits).toBe(true);
    const holders = report.segments.filter((s) => s.text.includes(quote));
    expect(holders).toHaveLength(1);
    expect(report.segments.some((s) => /“[^”]*$/u.test(s.text))).toBe(false);
  });

  it('gives up cleanly on one unbreakable span longer than a post', () => {
    const report = fitByMoving(
      [seg('a', 'x'.repeat(400))],
      { ...X, protectedRanges: () => [{ start: 0, end: 400 }] },
      minter(),
    );
    expect(report.fits).toBe(false);
    expect(report.segments).toHaveLength(1);
  });
});

describe('dropTrailingHashtags', () => {
  const fits = (limit: number) => (text: string) => text.length <= limit;

  it('drops hashtags from the end, one at a time, only until it fits', () => {
    expect(dropTrailingHashtags('A post. #One #Two #Three', fits(15))).toBe(
      'A post. #One',
    );
    expect(dropTrailingHashtags('A post. #One #Two', fits(100))).toBe(
      'A post. #One #Two',
    );
  });

  it('never touches a hashtag inside the text, or the link placed by code', () => {
    const link = '\n\nhttps://example.org/x';
    expect(
      dropTrailingHashtags(`About #Water today.${link}`, fits(10), link),
    ).toBe(`About #Water today.${link}`);
    expect(
      dropTrailingHashtags(`A post. #One #Two${link}`, fits(35), link),
    ).toBe(`A post. #One${link}`);
  });
});
