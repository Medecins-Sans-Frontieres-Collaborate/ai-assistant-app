import {
  PAGE_JOIN_SEPARATOR,
  SourcePage,
  formatPageSelection,
  joinPages,
  parsePageSelection,
  selectBatch,
  selectBatchEndingBefore,
  selectionLength,
  splitExtractedPages,
} from '@/lib/utils/shared/translation/pageBatches';

import { describe, expect, it } from 'vitest';

/** Ten characters per page, so budgets are easy to reason about. */
const PAGE_CHARS = 10;
const pagesOf = (...numbers: number[]): SourcePage[] =>
  numbers.map((page) => ({ page, text: String(page % 10).repeat(PAGE_CHARS) }));
/** Joined length of `count` fixture pages. */
const joinedLength = (count: number) =>
  count * PAGE_CHARS + (count - 1) * PAGE_JOIN_SEPARATOR.length;

describe('splitExtractedPages', () => {
  it('splits pdf.js marker output and drops the markers', () => {
    const pages = splitExtractedPages(
      '--- Page 1 ---\nFirst page\n\n--- Page 2 ---\nSecond page',
    );
    expect(pages).toEqual([
      { page: 1, text: 'First page' },
      { page: 2, text: 'Second page' },
    ]);
  });

  it('keeps the real page numbers when empty pages were skipped', () => {
    const pages = splitExtractedPages(
      '--- Page 1 ---\nCover\n\n--- Page 4 ---\nBody',
    );
    expect(pages.map((page) => page.page)).toEqual([1, 4]);
  });

  it('splits form-feed separated pdftotext output and skips blank pages', () => {
    const pages = splitExtractedPages('One\f\fThree\f');
    expect(pages).toEqual([
      { page: 1, text: 'One' },
      { page: 3, text: 'Three' },
    ]);
  });

  it('treats unmarked text as a single page and blank text as no pages', () => {
    expect(splitExtractedPages('  plain text  ')).toEqual([
      { page: 1, text: 'plain text' },
    ]);
    expect(splitExtractedPages(' \n ')).toEqual([]);
  });

  it('does not treat a marker-like phrase inside a line as a page break', () => {
    const pages = splitExtractedPages('see --- Page 2 --- for details');
    expect(pages).toHaveLength(1);
  });
});

describe('joinPages and selectionLength', () => {
  it('joins in document order regardless of selection order', () => {
    const pages = pagesOf(1, 2, 3);
    expect(joinPages(pages, [3, 1])).toBe(
      `${pages[0].text}${PAGE_JOIN_SEPARATOR}${pages[2].text}`,
    );
    expect(selectionLength(pages, [3, 1])).toBe(joinedLength(2));
  });
});

describe('selectBatch', () => {
  const pages = pagesOf(1, 2, 3, 4, 5);

  it('includes the page that lands exactly on the budget', () => {
    expect(selectBatch(pages, joinedLength(3))).toEqual([1, 2, 3]);
  });

  it('excludes the page that would exceed the budget by one character', () => {
    expect(selectBatch(pages, joinedLength(3) - 1)).toEqual([1, 2]);
  });

  it('starts at the first page with text at or after the start page', () => {
    expect(selectBatch(pagesOf(1, 4, 5), joinedLength(2), 2)).toEqual([4, 5]);
  });

  it('returns nothing when the first page alone is over budget', () => {
    expect(selectBatch(pages, PAGE_CHARS - 1)).toEqual([]);
  });

  it('returns nothing past the end of the document', () => {
    expect(selectBatch(pages, joinedLength(3), 6)).toEqual([]);
  });

  it('never returns a batch longer than the budget', () => {
    for (let budget = 0; budget <= joinedLength(5) + 5; budget++) {
      expect(
        selectionLength(pages, selectBatch(pages, budget)),
      ).toBeLessThanOrEqual(budget);
    }
  });
});

describe('selectBatchEndingBefore', () => {
  const pages = pagesOf(1, 2, 3, 4, 5);

  it('walks backwards and returns pages in document order', () => {
    expect(selectBatchEndingBefore(pages, joinedLength(2), 5)).toEqual([3, 4]);
  });

  it('respects the budget boundary exactly', () => {
    expect(selectBatchEndingBefore(pages, joinedLength(2) - 1, 5)).toEqual([4]);
  });

  it('returns nothing before the first page', () => {
    expect(selectBatchEndingBefore(pages, joinedLength(2), 1)).toEqual([]);
  });
});

describe('formatPageSelection', () => {
  it('collapses consecutive pages into ranges', () => {
    expect(formatPageSelection([3, 1, 2, 7, 7, 9, 10])).toBe('1-3, 7, 9-10');
  });

  it('formats an empty selection as an empty string', () => {
    expect(formatPageSelection([])).toBe('');
  });
});

describe('parsePageSelection', () => {
  const pages = pagesOf(1, 2, 3, 5, 8);

  it('parses numbers and ranges with mixed separators and dashes', () => {
    expect(parsePageSelection('1-2; 5 , 8', pages)).toEqual({
      ok: true,
      pages: [1, 2, 5, 8],
    });
    expect(parsePageSelection('2 – 5', pages)).toEqual({
      ok: true,
      pages: [2, 3, 5],
    });
  });

  it('round-trips with formatPageSelection', () => {
    const selected = [1, 2, 3, 8];
    expect(parsePageSelection(formatPageSelection(selected), pages)).toEqual({
      ok: true,
      pages: selected,
    });
  });

  it('skips pages without text inside a range', () => {
    expect(parsePageSelection('3-7', pages)).toEqual({
      ok: true,
      pages: [3, 5],
    });
  });

  it('handles a huge range without iterating it', () => {
    expect(parsePageSelection('1-999999999', pages)).toEqual({
      ok: true,
      pages: [1, 2, 3, 5, 8],
    });
  });

  it('refuses empty, malformed, reversed, and out-of-document input', () => {
    expect(parsePageSelection('  ', pages)).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(parsePageSelection('1, two', pages)).toMatchObject({
      ok: false,
      reason: 'invalid',
      detail: 'two',
    });
    expect(parsePageSelection('5-2', pages)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parsePageSelection('0', pages)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parsePageSelection('6-7', pages)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
