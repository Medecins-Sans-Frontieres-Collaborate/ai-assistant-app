import { SourcePage } from '@/lib/utils/shared/translation/pageBatches';
import {
  PAGE_COUNTER_MIN_PAGES,
  PAGE_COUNTER_MIN_SHARE,
  nearestPage,
  stripPageCounters,
} from '@/lib/utils/shared/translation/pageSheets';

import { describe, expect, it } from 'vitest';

/** `total` pages of which the first `withCounter` start with their counter. */
function document(total: number, withCounter: number): SourcePage[] {
  return Array.from({ length: total }, (_, index) => {
    const page = index + 1;
    return {
      page,
      text:
        page <= withCounter
          ? `Page ${page} / ${total} Body ${page}`
          : `Body ${page}`,
    };
  });
}

describe('stripPageCounters', () => {
  it('removes a counter at the start of each page', () => {
    expect(stripPageCounters(document(4, 4)).map((page) => page.text)).toEqual([
      'Body 1',
      'Body 2',
      'Body 3',
      'Body 4',
    ]);
  });

  it('tolerates the uneven spacing extraction leaves', () => {
    const pages = [
      { page: 1, text: 'Page   1   / 409 Exported on: 30/01/2025' },
      { page: 2, text: 'Page   2   / 409 ISBN' },
    ];
    expect(stripPageCounters(pages).map((page) => page.text)).toEqual([
      'Exported on: 30/01/2025',
      'ISBN',
    ]);
  });

  it('understands other wordings and a counter at the end', () => {
    expect(
      stripPageCounters([
        { page: 1, text: 'Seite 1 von 2 Titel' },
        { page: 2, text: 'Seite 2 von 2 Text' },
      ]).map((page) => page.text),
    ).toEqual(['Titel', 'Text']);
    expect(
      stripPageCounters([
        { page: 1, text: 'Title\n1 / 2' },
        { page: 2, text: 'Body\n2 / 2' },
      ]).map((page) => page.text),
    ).toEqual(['Title', 'Body']);
  });

  it('treats a word before the number as a label only when pages share it', () => {
    expect(
      stripPageCounters([
        { page: 1, text: 'Dose 1 / 2 daily' },
        { page: 2, text: 'Take 2 / 2 tablets' },
      ]).map((page) => page.text),
    ).toEqual(['Dose 1 / 2 daily', 'Take 2 / 2 tablets']);
    expect(
      stripPageCounters([
        { page: 1, text: 'Ends with a word 1 / 2' },
        { page: 2, text: 'Another ending 2 / 2' },
      ]).map((page) => page.text),
    ).toEqual(['Ends with a word', 'Another ending']);
  });

  it('strips at the minimum share of pages and not one page under it', () => {
    const total = 10;
    const needed = Math.ceil(total * PAGE_COUNTER_MIN_SHARE);
    expect(stripPageCounters(document(total, needed))[0].text).toBe('Body 1');
    expect(stripPageCounters(document(total, needed - 1))[0].text).toBe(
      `Page 1 / ${total} Body 1`,
    );
  });

  it('needs the counter on at least the minimum number of pages', () => {
    expect(PAGE_COUNTER_MIN_PAGES).toBe(2);
    const single = [{ page: 1, text: 'Page 1 / 1 Body' }];
    expect(stripPageCounters(single)).toEqual(single);
  });

  it('leaves text that only looks like a counter', () => {
    // Names another page than the one it is on.
    const wrongPage = [
      { page: 1, text: '3 of 5 patients improved' },
      { page: 2, text: '3 of 5 patients relapsed' },
    ];
    expect(stripPageCounters(wrongPage)).toEqual(wrongPage);
    // A "total" smaller than the document cannot be its page count.
    const smallTotal = [
      { page: 1, text: '1 of 2 doses' },
      { page: 2, text: '2 of 2 doses' },
      { page: 3, text: 'Other' },
    ];
    expect(stripPageCounters(smallTotal)).toEqual(smallTotal);
    // Totals that disagree are not one running header.
    const mixed = [
      { page: 1, text: '1 / 7 a' },
      { page: 2, text: '2 / 9 b' },
    ];
    expect(stripPageCounters(mixed)).toEqual(mixed);
  });

  it('keeps page numbers and handles no pages', () => {
    expect(stripPageCounters([])).toEqual([]);
    expect(stripPageCounters(document(3, 3)).map((page) => page.page)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('nearestPage', () => {
  const pages = [2, 3, 10].map((page) => ({ page, text: 'x' }));

  it('returns the page itself when it has text', () => {
    expect(nearestPage(pages, 3)).toBe(3);
  });

  it('returns the closest page with text otherwise, clamping at both ends', () => {
    expect(nearestPage(pages, 1)).toBe(2);
    expect(nearestPage(pages, 8)).toBe(10);
    expect(nearestPage(pages, 500)).toBe(10);
  });

  it('returns null without pages', () => {
    expect(nearestPage([], 1)).toBeNull();
  });
});
