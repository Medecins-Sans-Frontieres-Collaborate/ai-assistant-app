import {
  MAX_CHANGE_EDITS,
  isValidSelection,
  sanitizeChangeEdits,
  stampSelectionAnchors,
} from '@/lib/utils/shared/translation/changeRequest';

import { describe, expect, it } from 'vitest';

const TRANSLATION = 'Tome 1 comprimido. Luego tome 1 comprimido más.';

describe('isValidSelection', () => {
  it('accepts a passage at its real offset', () => {
    expect(
      isValidSelection(TRANSLATION, { text: 'Luego tome', start: 19 }),
    ).toBe(true);
  });

  it('refuses the same text one character off, and malformed input', () => {
    expect(
      isValidSelection(TRANSLATION, { text: 'Luego tome', start: 18 }),
    ).toBe(false);
    expect(isValidSelection(TRANSLATION, { text: '   ', start: 4 })).toBe(
      false,
    );
    expect(isValidSelection(TRANSLATION, { text: 'Tome', start: -1 })).toBe(
      false,
    );
    expect(isValidSelection(TRANSLATION, { text: 'Tome', start: 0.5 })).toBe(
      false,
    );
    expect(
      isValidSelection(TRANSLATION, {
        text: 7,
        start: 0,
      } as unknown as { text: string; start: number }),
    ).toBe(false);
  });
});

describe('sanitizeChangeEdits', () => {
  const edit = (before: string, after = 'x') => ({
    before,
    after,
    reason: 'r',
  });

  it('keeps edits found in the translation and drops the rest', () => {
    expect(
      sanitizeChangeEdits(
        [
          edit('1 comprimido', '1 tableta'),
          edit('no such text'),
          edit('Luego', 'Luego'),
          edit('   '),
          null,
          { before: 'Tome', after: 3 },
        ],
        TRANSLATION,
      ),
    ).toEqual([{ before: '1 comprimido', after: '1 tableta', reason: 'r' }]);
  });

  it('returns nothing for a non-array and tolerates a missing reason', () => {
    expect(sanitizeChangeEdits('edits', TRANSLATION)).toEqual([]);
    expect(
      sanitizeChangeEdits([{ before: 'Tome', after: 'Tomar' }], TRANSLATION),
    ).toEqual([{ before: 'Tome', after: 'Tomar', reason: '' }]);
  });

  it('limits edits to the selection when there is one', () => {
    const selection = { text: 'Luego tome 1 comprimido más.', start: 19 };
    expect(
      sanitizeChangeEdits(
        [edit('Tome 1', 'Tomar 1'), edit('comprimido más', 'tableta más')],
        TRANSLATION,
        selection,
      ).map((e) => e.before),
    ).toEqual(['comprimido más']);
  });

  it('keeps exactly the maximum and drops the one after it', () => {
    const text = Array.from(
      { length: MAX_CHANGE_EDITS + 1 },
      (_, i) => `w${i};`,
    ).join(' ');
    const edits = Array.from({ length: MAX_CHANGE_EDITS + 1 }, (_, i) =>
      edit(`w${i};`),
    );
    expect(
      sanitizeChangeEdits(edits.slice(0, MAX_CHANGE_EDITS), text),
    ).toHaveLength(MAX_CHANGE_EDITS);
    expect(sanitizeChangeEdits(edits, text)).toHaveLength(MAX_CHANGE_EDITS);
  });
});

describe('stampSelectionAnchors', () => {
  it('anchors a repeated phrase where it was selected, not at its first occurrence', () => {
    const selection = { text: 'Luego tome 1 comprimido más.', start: 19 };
    const [stamped] = stampSelectionAnchors(TRANSLATION, selection, [
      { before: '1 comprimido' },
    ]);
    expect(stamped.anchorStart).toBe(TRANSLATION.lastIndexOf('1 comprimido'));
    expect(stamped.anchorStart).not.toBe(TRANSLATION.indexOf('1 comprimido'));
    expect(
      TRANSLATION.endsWith(stamped.anchorContext!, stamped.anchorStart),
    ).toBe(true);
  });

  it('gives two edits with the same target two different places', () => {
    const text = 'uno dos uno dos';
    const stamped = stampSelectionAnchors(text, { text, start: 0 }, [
      { before: 'uno' },
      { before: 'uno' },
    ]);
    expect(stamped.map((e) => e.anchorStart)).toEqual([0, 8]);
  });

  it('leaves an edit outside the selection without an anchor', () => {
    const [stamped] = stampSelectionAnchors(
      TRANSLATION,
      { text: 'Luego', start: 19 },
      [{ before: 'Tome' }],
    );
    expect(stamped.anchorStart).toBeUndefined();
  });
});
