import {
  DocumentUnit,
  comparableText,
  placeUnits,
} from '@/lib/utils/shared/documents/documentModel';

import { describe, expect, it } from 'vitest';

/**
 * placeUnits: a Word document's paragraphs (no pages in the file) placed
 * on the pages of its PDF rendering, by how their text starts.
 */

const unit = (
  id: string,
  text: string,
  page: number | null = null,
  box: DocumentUnit['box'] = null,
): DocumentUnit => ({ id, page, kind: 'body', text, box, runs: [] });

describe('comparableText', () => {
  it('ignores case, spacing, curly quotes and bullets', () => {
    expect(comparableText('  • It’s  “Northwind”\nNow ')).toBe(
      'it\'s "northwind" now',
    );
  });
});

describe('placeUnits', () => {
  it('places each paragraph on the block that starts like it', () => {
    const placed = placeUnits(
      [unit('a', 'Northwind annual review'), unit('b', 'Our clinics served')],
      [
        unit('p1', 'Northwind annual review', 1, [10, 10, 200, 30]),
        unit('p2', 'Our clinics served', 2, [10, 40, 200, 60]),
      ],
    );
    expect(placed.map((u) => [u.page, u.box])).toEqual([
      [1, [10, 10, 200, 30]],
      [2, [10, 40, 200, 60]],
    ]);
  });

  it('grows a paragraph over the blocks that continue it on its page', () => {
    const long = 'The first part of a long paragraph and its second part here';
    const [placed] = placeUnits(
      [unit('a', long)],
      [
        unit('p1', 'The first part of a long paragraph', 1, [10, 10, 300, 30]),
        unit('p2', 'and its second part here', 1, [10, 30, 250, 50]),
      ],
    );
    expect(placed.box).toEqual([10, 10, 300, 50]);
  });

  it('searches on from the last one placed, so a repeated line lands in order', () => {
    const placed = placeUnits(
      [unit('a', 'Total'), unit('b', 'Middle'), unit('c', 'Total')],
      [
        unit('p1', 'Total', 1, [0, 0, 1, 1]),
        unit('p2', 'Middle', 1, [0, 2, 1, 3]),
        unit('p3', 'Total', 2, [0, 0, 1, 1]),
      ],
    );
    expect(placed.map((u) => u.page)).toEqual([1, 1, 2]);
  });

  it('leaves a paragraph it cannot find unplaced', () => {
    const [placed] = placeUnits(
      [unit('a', 'Not in the rendering')],
      [unit('p1', 'Something else', 1, [0, 0, 1, 1])],
    );
    expect(placed.page).toBeNull();
    expect(placed.box).toBeNull();
  });
});
