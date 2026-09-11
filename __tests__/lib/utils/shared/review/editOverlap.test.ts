/**
 * The boundary rule for typing near a suggestion
 * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §4): only a change strictly INSIDE a
 * span destroys it. Typing right up against a suggestion leaves its text — and
 * its `before` — intact, so it must not count.
 */
import {
  rangeTouchesSpan,
  touchedSpanIds,
} from '@/lib/utils/shared/review/editLocation';

import { describe, expect, it } from 'vitest';

const span = { id: 'e', from: 10, to: 20 };

describe('rangeTouchesSpan', () => {
  it('counts an insertion strictly inside', () => {
    expect(rangeTouchesSpan(span, 15, 15)).toBe(true);
  });

  it('ignores an insertion at either edge', () => {
    expect(rangeTouchesSpan(span, 10, 10)).toBe(false);
    expect(rangeTouchesSpan(span, 20, 20)).toBe(false);
  });

  it('ignores deleting the character that abuts the span', () => {
    expect(rangeTouchesSpan(span, 9, 10)).toBe(false);
    expect(rangeTouchesSpan(span, 20, 21)).toBe(false);
  });

  it('counts deleting the first or last character of the span', () => {
    expect(rangeTouchesSpan(span, 10, 11)).toBe(true);
    expect(rangeTouchesSpan(span, 19, 20)).toBe(true);
  });

  it('counts a replacement that straddles an edge', () => {
    expect(rangeTouchesSpan(span, 5, 12)).toBe(true);
    expect(rangeTouchesSpan(span, 18, 25)).toBe(true);
  });

  it('counts a deletion that swallows the whole span', () => {
    expect(rangeTouchesSpan(span, 0, 30)).toBe(true);
  });
});

describe('touchedSpanIds', () => {
  const spans = [
    { id: 'a', from: 0, to: 5 },
    { id: 'b', from: 10, to: 15 },
    { id: 'c', from: 20, to: 25 },
  ];

  it('names every span a set of ranges alters, in span order, once each', () => {
    expect(
      touchedSpanIds(spans, [
        { from: 22, to: 23 },
        { from: 2, to: 12 },
        { from: 3, to: 3 },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('is empty when the change lands between suggestions', () => {
    expect(touchedSpanIds(spans, [{ from: 7, to: 8 }])).toEqual([]);
  });
});
