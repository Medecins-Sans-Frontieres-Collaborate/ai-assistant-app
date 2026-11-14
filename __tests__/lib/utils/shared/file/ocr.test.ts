import {
  SPARSE_TEXT_CHARS_PER_PAGE,
  SPARSE_TEXT_PAGE_SHARE,
  looksLikeSparseText,
  supportsOcr,
} from '@/lib/utils/shared/file/ocr';

import { describe, expect, it } from 'vitest';

describe('supportsOcr', () => {
  it.each([
    ['scan.pdf', true],
    ['SCAN.PDF', true],
    ['scan.pdf ', true],
    ['scan.docx', false],
    ['pdf', false],
    ['scan.pdf.txt', false],
  ])('%j -> %s', (name, expected) => {
    expect(supportsOcr(name)).toBe(expected);
  });
});

describe('looksLikeSparseText', () => {
  const PAGES = 10;
  const fullPages = (charsPerPage: number) =>
    Array.from({ length: PAGES }, () => charsPerPage);

  it('accepts ordinary prose', () => {
    expect(looksLikeSparseText(fullPages(2000), PAGES)).toBe(false);
  });

  it('brackets the characters-per-page threshold', () => {
    // The fixture is built from the threshold, so the two stay in step.
    expect(SPARSE_TEXT_CHARS_PER_PAGE).toBeGreaterThan(1);
    expect(
      looksLikeSparseText(fullPages(SPARSE_TEXT_CHARS_PER_PAGE - 1), PAGES),
    ).toBe(true);
    expect(
      looksLikeSparseText(fullPages(SPARSE_TEXT_CHARS_PER_PAGE), PAGES),
    ).toBe(false);
    expect(
      looksLikeSparseText(fullPages(SPARSE_TEXT_CHARS_PER_PAGE + 1), PAGES),
    ).toBe(false);
  });

  it('brackets the share of pages with text', () => {
    const atShare = Math.round(PAGES * SPARSE_TEXT_PAGE_SHARE);
    const dense = (pagesWithText: number) =>
      Array.from({ length: pagesWithText }, () => 5000);
    expect(looksLikeSparseText(dense(atShare - 1), PAGES)).toBe(true);
    expect(looksLikeSparseText(dense(atShare), PAGES)).toBe(false);
    expect(looksLikeSparseText(dense(atShare + 1), PAGES)).toBe(false);
  });

  it('keeps a document authored exactly at the average on the text side', () => {
    // 3 pages at exactly the threshold: 360 / 3 must not read as < 120.
    expect(
      looksLikeSparseText(
        [SPARSE_TEXT_CHARS_PER_PAGE * 3, 0.1 + 0.2 - 0.3, 0].filter(
          (n) => n > 1,
        ),
        1,
      ),
    ).toBe(false);
    expect(
      looksLikeSparseText(
        [SPARSE_TEXT_CHARS_PER_PAGE, SPARSE_TEXT_CHARS_PER_PAGE * 2],
        3,
      ),
    ).toBe(false);
  });

  it('does not judge a single page', () => {
    expect(looksLikeSparseText([3], 1)).toBe(false);
    expect(looksLikeSparseText([3, 3], 2)).toBe(true);
  });

  it('treats a document with no text at all as sparse', () => {
    expect(looksLikeSparseText([], PAGES)).toBe(true);
  });
});
