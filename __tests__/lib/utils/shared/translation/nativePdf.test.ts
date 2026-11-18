import {
  MAX_STEP_INSTRUCTION_CHARS,
  NATIVE_PDF_MAX_PAGES,
  NATIVE_PDF_MAX_TRANSLATION_CHARS,
  NATIVE_PDF_STEPS,
  NativePdfFitReport,
  NativePdfIssue,
  REFIT_SCALE_THRESHOLD,
  charBudget,
  parsePageSelection,
  repairTranslationTags,
  sanitizeStepInstructions,
  sanitizeTranslationEdits,
  selectRefitTargets,
  visibleLength,
} from '@/lib/utils/shared/translation/nativePdf';

import { describe, expect, it } from 'vitest';

describe('NATIVE_PDF_STEPS', () => {
  it('fixes the order every run follows', () => {
    expect(NATIVE_PDF_STEPS.map((step) => step.id)).toEqual([
      'extract',
      'analyze',
      'translate',
      'rebuild',
      'verify',
      'refit',
    ]);
  });
});

describe('sanitizeStepInstructions', () => {
  it('keeps trimmed text for the model steps only', () => {
    expect(
      sanitizeStepInstructions({
        analyze: '  keep product names  ',
        translate: 'formal register',
        verify: 'ignore the footer',
        // Sandbox steps run a fixed script: nothing to instruct.
        extract: 'skip page 2',
        rebuild: 'use Comic Sans',
        skipVerify: true,
      }),
    ).toEqual({
      analyze: 'keep product names',
      translate: 'formal register',
      verify: 'ignore the footer',
    });
  });

  it('drops empty and non-string values, and non-objects entirely', () => {
    expect(sanitizeStepInstructions({ translate: '   ', verify: 3 })).toEqual(
      {},
    );
    expect(sanitizeStepInstructions(null)).toEqual({});
    expect(sanitizeStepInstructions('translate everything')).toEqual({});
  });

  it('caps an instruction at the limit', () => {
    const long = 'x'.repeat(MAX_STEP_INSTRUCTION_CHARS + 50);
    expect(
      sanitizeStepInstructions({ translate: long }).translate,
    ).toHaveLength(MAX_STEP_INSTRUCTION_CHARS);
  });
});

describe('parsePageSelection', () => {
  it('defaults to the first pages a run may hold', () => {
    expect(parsePageSelection('', 3)).toEqual({ ok: true, pages: [1, 2, 3] });
    expect(parsePageSelection(undefined, 2)).toEqual({
      ok: true,
      pages: [1, 2],
    });
  });

  it('reads lists and ranges, sorted and de-duplicated', () => {
    expect(parsePageSelection('8, 1-2, 2', 6)).toEqual({
      ok: true,
      pages: [1, 2, 8],
    });
  });

  it('accepts exactly the page limit and refuses one more', () => {
    const atLimit = parsePageSelection(`1-${NATIVE_PDF_MAX_PAGES}`);
    expect(atLimit.ok).toBe(true);
    const over = parsePageSelection(`1-${NATIVE_PDF_MAX_PAGES + 1}`);
    expect(over.ok).toBe(false);
  });

  it('refuses unreadable and inverted ranges', () => {
    expect(parsePageSelection('one').ok).toBe(false);
    expect(parsePageSelection('5-2').ok).toBe(false);
    expect(parsePageSelection('0').ok).toBe(false);
  });
});

describe('repairTranslationTags', () => {
  const source = 'See <g1>the report</g1> and <b>act</b>.';

  it('leaves a valid translation untouched', () => {
    const translation = 'Voir <g1>le rapport</g1> et <b>agir</b>.';
    expect(repairTranslationTags(source, translation)).toEqual({
      text: translation,
      repaired: false,
    });
  });

  it('removes tags the source does not have', () => {
    expect(
      repairTranslationTags(source, 'Voir <g2>le rapport</g2> <i>ici</i>.'),
    ).toEqual({ text: 'Voir le rapport ici.', repaired: true });
  });

  it('closes an opener left open and drops a stray closer', () => {
    expect(repairTranslationTags(source, 'Voir <g1>le rapport.').text).toBe(
      'Voir <g1>le rapport.</g1>',
    );
    expect(repairTranslationTags(source, 'Voir le rapport</g1>.').text).toBe(
      'Voir le rapport.',
    );
  });

  it('removes arbitrary markup a model might add', () => {
    expect(
      repairTranslationTags(source, 'Voir <span style="x">le</span> rapport.'),
    ).toEqual({ text: 'Voir le rapport.', repaired: true });
  });
});

describe('visibleLength and charBudget', () => {
  it('does not count tags', () => {
    expect(visibleLength('<g1>abc</g1> <b>de</b>')).toBe(6);
  });

  it('scales the budget by spare room, within bounds', () => {
    expect(charBudget({ chars: 100, roomFactor: 1 })).toBe(100);
    expect(charBudget({ chars: 100, roomFactor: 1.3 })).toBe(130);
    // Room beyond double, or below the source's own box, is not trusted.
    expect(charBudget({ chars: 100, roomFactor: 5 })).toBe(200);
    expect(charBudget({ chars: 100, roomFactor: 0.6 })).toBe(100);
    expect(charBudget({ chars: 2, roomFactor: 1 })).toBe(8);
  });
});

describe('selectRefitTargets', () => {
  const fit = (
    id: string,
    scale: number,
    fits = true,
    n = 1,
  ): NativePdfFitReport => ({ id, page: 1, n, scale, fits });
  const lengths = new Map([
    ['a', 100],
    ['b', 100],
    ['c', 100],
  ]);

  it('brackets the scale threshold', () => {
    const targets = selectRefitTargets(
      [
        // Exactly at the threshold, as the engine would report it: kept.
        fit('a', REFIT_SCALE_THRESHOLD - 0.0000001, true, 1),
        fit('b', REFIT_SCALE_THRESHOLD - 0.01, true, 2),
        fit('c', 1, true, 3),
      ],
      [],
      lengths,
    );
    expect(targets.map((target) => target.id)).toEqual(['b']);
    expect(targets[0].reason).toBe('scale');
    expect(targets[0].targetChars).toBeLessThan(100);
  });

  it('refits a unit that did not fit at all, however it was scaled', () => {
    const targets = selectRefitTargets([fit('a', 0.5, false)], [], lengths);
    expect(targets).toHaveLength(1);
    // Never asks for less than half the current length.
    expect(targets[0].targetChars).toBe(50);
  });

  it('refits on a major visual fit issue but not on minor or unrelated ones', () => {
    const issue = (
      n: number | null,
      kind: NativePdfIssue['kind'],
      severity: NativePdfIssue['severity'],
    ): NativePdfIssue => ({ page: 1, n, kind, severity, note: '' });
    const fits = [
      fit('a', 1, true, 1),
      fit('b', 1, true, 2),
      fit('c', 1, true, 3),
    ];
    const targets = selectRefitTargets(
      fits,
      [
        issue(1, 'overflow', 'major'),
        issue(2, 'overflow', 'minor'),
        // Shortening cannot cure untranslated text.
        issue(3, 'leftover_source', 'major'),
        issue(null, 'overlap', 'major'),
      ],
      lengths,
    );
    expect(targets).toEqual([{ id: 'a', targetChars: 85, reason: 'visual' }]);
  });

  it('ignores units that have no translation to shorten', () => {
    expect(selectRefitTargets([fit('zz', 0.5, false)], [], lengths)).toEqual(
      [],
    );
  });
});

describe('sanitizeTranslationEdits', () => {
  const units = [
    { id: 'a', text: 'See <g1>the report</g1>.' },
    { id: 'b', text: 'Grasberg' },
    { id: 'c', text: 'Country' },
  ];

  it('keeps translations for known units and drops unknown ids', () => {
    const result = sanitizeTranslationEdits(
      { a: 'Voir <g1>le rapport</g1>.', c: ' Pays ', zz: 'injected' },
      units,
    );
    expect([...result.translations]).toEqual([
      ['a', 'Voir <g1>le rapport</g1>.'],
      ['c', 'Pays'],
    ]);
    expect(result.repaired).toEqual([]);
    expect(result.tooLong).toEqual([]);
  });

  it('treats null, empty and missing as keep-as-written', () => {
    const result = sanitizeTranslationEdits({ a: null, b: '   ' }, units);
    expect(result.translations.size).toBe(0);
  });

  it('repairs tags against the unit source and reports it', () => {
    const result = sanitizeTranslationEdits(
      { a: 'Voir <g2>le rapport</g2> <script>x</script>.' },
      units,
    );
    expect(result.translations.get('a')).toBe('Voir le rapport x.');
    expect(result.repaired).toEqual(['a']);
  });

  it('accepts a text at the length limit and refuses one over it', () => {
    const atLimit = 'x'.repeat(NATIVE_PDF_MAX_TRANSLATION_CHARS);
    const result = sanitizeTranslationEdits(
      { b: atLimit, c: `${atLimit}x` },
      units,
    );
    expect(result.translations.get('b')).toHaveLength(
      NATIVE_PDF_MAX_TRANSLATION_CHARS,
    );
    // Refused, not cut: cutting would change what the person wrote.
    expect(result.translations.has('c')).toBe(false);
    expect(result.tooLong).toEqual(['c']);
  });

  it('returns nothing for input that is not an object of units', () => {
    for (const value of [null, 'a', 3, ['a']]) {
      expect(sanitizeTranslationEdits(value, units).translations.size).toBe(0);
    }
  });
});
