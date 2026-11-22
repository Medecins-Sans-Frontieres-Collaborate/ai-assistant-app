import {
  AUTO_MAX_SHIFT,
  AUTO_MIN_SIZE_RATIO,
  MAX_BRIEF_TERMS,
  MAX_BRIEF_TERM_CHARS,
  MAX_STEP_INSTRUCTION_CHARS,
  NATIVE_PDF_EXPORT_FORMATS,
  NATIVE_PDF_MAX_FONT_SIZE,
  NATIVE_PDF_MAX_PAGES,
  NATIVE_PDF_MAX_SHIFT,
  NATIVE_PDF_MAX_TRANSLATION_CHARS,
  NATIVE_PDF_MIN_FONT_SIZE,
  NATIVE_PDF_STEPS,
  NativePdfFitReport,
  NativePdfIssue,
  REFIT_SCALE_THRESHOLD,
  addsAbbreviation,
  breakLike,
  charBudget,
  dropsTerm,
  hasLayoutFixes,
  layoutScore,
  mergeBriefs,
  missingTerms,
  parsePageSelection,
  planLayoutFixes,
  repairTranslationTags,
  sanitizeBrief,
  sanitizeExportFormats,
  sanitizeLanguageCode,
  sanitizeStepInstructions,
  sanitizeTranslationEdits,
  sanitizeUnitStyle,
  sanitizeUnitStyles,
  selectRefitTargets,
  termCandidates,
  termKey,
  termsIn,
  visibleLength,
  wordingInCaseOf,
} from '@/lib/utils/shared/translation/nativePdf';
import {
  NATIVE_PDF_MAX_PAGES as REQUEST_PAGES,
  nativePdfLimits,
  splitIntoRequests,
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

describe('nativePdfLimits', () => {
  it('reads limits that are in order as they are', () => {
    expect(
      nativePdfLimits({
        defaultBatchPages: 6,
        maxBatchPages: 12,
        maxDocumentPages: 30,
      }),
    ).toEqual({
      defaultBatchPages: 6,
      maxBatchPages: 12,
      maxDocumentPages: 30,
    });
  });

  it('lowers a batch above the document total, and a default above the batch', () => {
    // Equal values are in order; one over is lowered.
    expect(
      nativePdfLimits({
        defaultBatchPages: 12,
        maxBatchPages: 12,
        maxDocumentPages: 12,
      }),
    ).toEqual({
      defaultBatchPages: 12,
      maxBatchPages: 12,
      maxDocumentPages: 12,
    });
    expect(
      nativePdfLimits({
        defaultBatchPages: 14,
        maxBatchPages: 13,
        maxDocumentPages: 12,
      }),
    ).toEqual({
      defaultBatchPages: 12,
      maxBatchPages: 12,
      maxDocumentPages: 12,
    });
  });

  it('falls back to one request per document when values are missing or unusable', () => {
    const fallback = {
      defaultBatchPages: REQUEST_PAGES,
      maxBatchPages: REQUEST_PAGES,
      maxDocumentPages: REQUEST_PAGES,
    };
    expect(nativePdfLimits(undefined)).toEqual(fallback);
    expect(
      nativePdfLimits({
        defaultBatchPages: 0,
        maxBatchPages: Number.NaN,
        maxDocumentPages: -3,
      }),
    ).toEqual(fallback);
  });
});

describe('splitIntoRequests', () => {
  const pages = (count: number) =>
    Array.from({ length: count }, (_, index) => index + 1);

  it('keeps a batch of exactly one request whole', () => {
    expect(splitIntoRequests(pages(REQUEST_PAGES))).toHaveLength(1);
  });

  it('starts a second request at one page more', () => {
    const requests = splitIntoRequests(pages(REQUEST_PAGES + 1));
    expect(requests.map((request) => request.length)).toEqual([
      REQUEST_PAGES,
      1,
    ]);
    expect(requests.flat()).toEqual(pages(REQUEST_PAGES + 1));
  });

  it('uses the request size it is given, and never less than one', () => {
    expect(splitIntoRequests([1, 2, 3, 8, 9], 2)).toEqual([
      [1, 2],
      [3, 8],
      [9],
    ]);
    expect(splitIntoRequests([4, 5], 0)).toEqual([[4], [5]]);
    expect(splitIntoRequests([])).toEqual([]);
  });
});

describe('sanitizeUnitStyle', () => {
  it('keeps a valid look as it is, colour in lowercase', () => {
    expect(
      sanitizeUnitStyle({ size: 12.5, color: '#FFCC00', dx: 4, dy: -6 }),
    ).toEqual({ size: 12.5, color: '#ffcc00', dx: 4, dy: -6 });
  });

  it('holds a size inside its range, at both ends', () => {
    expect(sanitizeUnitStyle({ size: NATIVE_PDF_MIN_FONT_SIZE })?.size).toBe(
      NATIVE_PDF_MIN_FONT_SIZE,
    );
    expect(
      sanitizeUnitStyle({ size: NATIVE_PDF_MIN_FONT_SIZE - 0.5 })?.size,
    ).toBe(NATIVE_PDF_MIN_FONT_SIZE);
    expect(sanitizeUnitStyle({ size: NATIVE_PDF_MAX_FONT_SIZE })?.size).toBe(
      NATIVE_PDF_MAX_FONT_SIZE,
    );
    expect(
      sanitizeUnitStyle({ size: NATIVE_PDF_MAX_FONT_SIZE + 1 })?.size,
    ).toBe(NATIVE_PDF_MAX_FONT_SIZE);
  });

  it('holds a move inside its range and drops a move of nothing', () => {
    expect(sanitizeUnitStyle({ dx: -1e9, dy: 1e9 })).toEqual({
      dx: -NATIVE_PDF_MAX_SHIFT,
      dy: NATIVE_PDF_MAX_SHIFT,
    });
    expect(sanitizeUnitStyle({ dx: 0, dy: 0 })).toBeUndefined();
  });

  it('drops what is not a size, a move or a colour', () => {
    expect(
      sanitizeUnitStyle({
        size: '12',
        dx: NaN,
        dy: Infinity,
        color: 'red;} body{display:none',
        font: 'Comic Sans',
      }),
    ).toBeUndefined();
    // Three hex digits and a missing hash are not the form the layout takes.
    expect(sanitizeUnitStyle({ color: '#fc0' })).toBeUndefined();
    expect(sanitizeUnitStyle({ color: 'ffcc00' })).toBeUndefined();
    for (const value of [null, 'x', 3, []]) {
      expect(sanitizeUnitStyle(value)).toBeUndefined();
    }
  });
});

describe('sanitizeUnitStyles', () => {
  const units = [{ id: 'p1-b0-0' }, { id: 'p1-b1-0' }];

  it("keeps styles of this document's units only, each sanitized", () => {
    expect(
      sanitizeUnitStyles(
        {
          'p1-b0-0': { size: 14, bogus: true },
          'p1-b1-0': { color: 'nope' },
          'p9-b0-0': { size: 20 },
          __proto__: { size: 30 },
        },
        units,
      ),
    ).toEqual({ 'p1-b0-0': { size: 14 } });
  });

  it('answers nothing for input that is not an object of styles', () => {
    for (const value of [undefined, null, 'x', [{ size: 12 }]]) {
      expect(sanitizeUnitStyles(value, units)).toEqual({});
    }
  });
});

describe('planLayoutFixes', () => {
  const fit = (id: string, n: number, scale = 1): NativePdfFitReport => ({
    id,
    page: 1,
    n,
    scale,
    fits: true,
  });
  const issue = (
    n: number,
    fix: Partial<NonNullable<NativePdfIssue['fix']>> | undefined,
    severity: NativePdfIssue['severity'] = 'major',
  ): NativePdfIssue => ({
    page: 1,
    n,
    kind: 'overflow',
    severity,
    note: '',
    fix: fix && { action: 'none', percent: 100, dx: 0, dy: 0, ...fix },
  });
  const units = [
    { id: 'a', size: 20 },
    { id: 'b', size: 20 },
  ];
  const lengths = new Map([
    ['a', 100],
    ['b', 100],
  ]);
  const plan = (
    issues: NativePdfIssue[],
    fits = [fit('a', 1), fit('b', 2)],
    styles = {},
  ) => planLayoutFixes({ fits, issues, lengths, units, styles });

  it('changes nothing on a clean page', () => {
    const clean = plan([]);
    expect(hasLayoutFixes(clean)).toBe(false);
    expect(clean.styles).toEqual({});
  });

  it('sets a smaller font, counted from the size shown', () => {
    // 20 pt already shrunk to 90% is shown at 18 pt; 90% of that is 16.2,
    // rounded down to a half point.
    const smaller = plan(
      [issue(1, { action: 'smaller', percent: 90 })],
      [fit('a', 1, 0.9), fit('b', 2)],
    );
    expect(smaller.styles).toEqual({ a: { size: 16 } });
    expect(smaller.resized).toEqual(['a']);
    expect(smaller.targets).toEqual([]);
  });

  it('never sets a font below the automatic floor, and shortens instead once there', () => {
    const floor = 20 * AUTO_MIN_SIZE_RATIO;
    const first = plan([issue(1, { action: 'smaller', percent: 10 })]);
    expect(first.styles.a.size).toBe(floor);
    // At the floor already: nothing left to take off, so the text gets shorter.
    const again = plan(
      [issue(1, { action: 'smaller', percent: 80 })],
      undefined,
      first.styles,
    );
    expect(again.resized).toEqual([]);
    expect(again.styles).toEqual(first.styles);
    expect(again.targets.map((target) => target.id)).toEqual(['a']);
  });

  it('moves a unit, inside the automatic limit, on top of an earlier move', () => {
    const moved = plan(
      [issue(1, { action: 'move', dx: 6, dy: -500 })],
      undefined,
      { a: { dx: 4 } },
    );
    expect(moved.styles).toEqual({ a: { dx: 10, dy: -AUTO_MAX_SHIFT } });
    expect(moved.moved).toEqual(['a']);
    // A minor remark is not worth moving a unit for.
    expect(
      hasLayoutFixes(plan([issue(1, { action: 'move', dy: 6 }, 'minor')])),
    ).toBe(false);
    // A move of nothing is no fix.
    expect(hasLayoutFixes(plan([issue(1, { action: 'move' })]))).toBe(false);
  });

  it('shortens by the prescribed share, held inside its limits', () => {
    const targets = (percent: number) =>
      plan([issue(1, { action: 'shorten', percent })]).targets[0].targetChars;
    expect(targets(80)).toBe(80);
    expect(targets(5)).toBe(50);
    expect(targets(100)).toBe(95);
  });

  it('prefers the layout report over a prescription: text shrunk too far gets shorter', () => {
    const shrunk = plan(
      [issue(1, { action: 'move', dx: 10 })],
      [fit('a', 1, REFIT_SCALE_THRESHOLD - 0.05), fit('b', 2)],
    );
    expect(shrunk.targets).toMatchObject([{ id: 'a', reason: 'scale' }]);
    expect(shrunk.moved).toEqual([]);
  });

  it("applies a minor finding's prescription, a major one first", () => {
    expect(
      plan([issue(2, { action: 'smaller', percent: 90 }, 'minor')]).styles,
    ).toEqual({ b: { size: 18 } });
    const both = plan([
      issue(1, { action: 'smaller', percent: 90 }, 'minor'),
      issue(1, { action: 'move', dy: 4 }, 'major'),
    ]);
    expect(both.styles).toEqual({ a: { dy: 4 } });
  });

  it('leaves a finding prescribed "none" alone, and shortens a major one with no prescription', () => {
    expect(hasLayoutFixes(plan([issue(1, { action: 'none' })]))).toBe(false);
    expect(plan([issue(1, undefined)]).targets).toMatchObject([
      { id: 'a', reason: 'visual' },
    ]);
    expect(hasLayoutFixes(plan([issue(1, undefined, 'minor')]))).toBe(false);
  });

  it('never touches a unit that was not translated or a page-level remark', () => {
    const untranslated = planLayoutFixes({
      fits: [fit('z', 1)],
      issues: [issue(1, { action: 'smaller', percent: 80 })],
      lengths,
      units: [{ id: 'z', size: 20 }],
    });
    expect(hasLayoutFixes(untranslated)).toBe(false);
    const remark = { ...issue(1, { action: 'smaller', percent: 80 }), n: null };
    expect(hasLayoutFixes(plan([remark]))).toBe(false);
  });

  it("gives a smaller font to the unit's peers on the page, and to no one else", () => {
    const peers = planLayoutFixes({
      fits: [
        fit('a', 1),
        fit('b', 2),
        fit('c', 3),
        { ...fit('d', 1), page: 2 },
        fit('e', 4),
      ],
      issues: [issue(1, { action: 'smaller', percent: 90 })],
      lengths: new Map(['a', 'b', 'c', 'd', 'e'].map((id) => [id, 100])),
      units: [
        { id: 'a', size: 20, peer: 'item' },
        { id: 'b', size: 20.1, peer: 'item' },
        { id: 'c', size: 20, peer: 'heading' },
        // Same style on another page: not a peer.
        { id: 'd', size: 20, peer: 'item' },
        // Already set smaller by an earlier fix: keeps its size.
        { id: 'e', size: 20, peer: 'item' },
      ],
      styles: { e: { size: 15 } },
    });
    expect(peers.styles).toEqual({
      a: { size: 18 },
      b: { size: 18 },
      e: { size: 15 },
    });
    expect(peers.resized).toEqual(['a', 'b']);
  });

  it('does not modify the styles it is given', () => {
    const given = { a: { dx: 4 } };
    plan([issue(1, { action: 'move', dx: 6 })], undefined, given);
    expect(given).toEqual({ a: { dx: 4 } });
  });
});

describe('layoutScore', () => {
  const fits: NativePdfFitReport[] = [
    { id: 'a', page: 1, n: 1, scale: 1, fits: true },
  ];
  const finding = (severity: NativePdfIssue['severity']): NativePdfIssue => ({
    page: 1,
    n: 1,
    kind: 'overlap',
    severity,
    note: '',
  });

  it('is zero for a clean page and grows with findings', () => {
    expect(layoutScore(fits, [])).toBe(0);
    expect(layoutScore(fits, [finding('minor')])).toBeGreaterThan(0);
  });

  it('counts one major finding as worse than several minor ones', () => {
    expect(layoutScore(fits, [finding('major')])).toBeGreaterThan(
      layoutScore(
        fits,
        Array.from({ length: 5 }, () => finding('minor')),
      ),
    );
  });

  it('counts a unit the layout could not fit like a major finding', () => {
    const unfit = [{ ...fits[0], fits: false }];
    expect(layoutScore(unfit, [])).toBe(layoutScore(fits, [finding('major')]));
    // Exactly at the shrink threshold is not unfit.
    const atLimit = [{ ...fits[0], scale: REFIT_SCALE_THRESHOLD - 1e-7 }];
    expect(layoutScore(atLimit, [])).toBe(0);
  });
});

describe('addsAbbreviation', () => {
  const full =
    'Examen de la proposition : infrastructures de santé résilientes';

  it('refuses a wording that abbreviates a word written out before', () => {
    expect(
      addsAbbreviation(full, 'Éval. du projet : infrastructures santé'),
    ).toBe(true);
    expect(
      addsAbbreviation('<b>Statut</b> du projet', '<b>Stat.</b> du projet'),
    ).toBe(true);
  });

  it('accepts a shorter wording without one', () => {
    expect(
      addsAbbreviation(full, 'Examen : infrastructures de santé résilientes'),
    ).toBe(false);
  });

  it('does not count the stop that ends the text, or one already there', () => {
    expect(
      addsAbbreviation('Vise à réduire les coûts.', 'Réduit les coûts.'),
    ).toBe(false);
    expect(
      addsAbbreviation(
        'Voir p. ex. le rapport annuel',
        'Voir p. ex. le rapport',
      ),
    ).toBe(false);
    expect(addsAbbreviation('Coût : 3.5 M€ par an', 'Coût : 3.5 M€/an')).toBe(
      false,
    );
  });
});

describe('the document brief', () => {
  it('treats tags, case and spacing as the same term', () => {
    expect(termKey('<b>3D Printing</b>\nfor  All')).toBe('3d printing for all');
    expect(termKey('PRIM-Vax')).not.toBe(termKey('PRIM Vax'));
  });

  it('accepts language tags and nothing else as a language code', () => {
    expect(sanitizeLanguageCode('de')).toBe('de');
    expect(sanitizeLanguageCode(' zh-Hant ')).toBe('zh-Hant');
    expect(sanitizeLanguageCode('jam')).toBe('jam');
    expect(sanitizeLanguageCode('de" onload="x')).toBe('');
    expect(sanitizeLanguageCode('german language')).toBe('');
    expect(sanitizeLanguageCode(7)).toBe('');
  });

  it('keeps what is usable of a brief from a client and drops the rest', () => {
    const brief = sanitizeBrief({
      language: {
        code: 'jam; drop table',
        name: ' Jamaican\nPatois ',
        note: 'x'.repeat(1000),
      },
      terms: [
        { source: 'PRIM-Vax', target: 'anything', keep: true },
        { source: 'prim-vax', target: 'duplicate', keep: false },
        { source: 'Cold Chain', target: 'Chaîne du froid', keep: false },
        { source: 'No target', keep: false },
        { source: 'y'.repeat(MAX_BRIEF_TERM_CHARS + 20), target: 't' },
        'not an entry',
      ],
    });
    expect(brief.language).toEqual({
      code: '',
      name: 'Jamaican Patois',
      note: 'x'.repeat(300),
    });
    expect(brief.terms.slice(0, 2)).toEqual([
      // A kept term is written as its source, whatever target was sent.
      { source: 'PRIM-Vax', target: 'PRIM-Vax', keep: true },
      { source: 'Cold Chain', target: 'Chaîne du froid', keep: false },
    ]);
    expect(brief.terms[2].source).toHaveLength(MAX_BRIEF_TERM_CHARS);
    expect(brief.terms).toHaveLength(3);
    expect(sanitizeBrief('nonsense')).toEqual({ terms: [] });
    expect(sanitizeBrief({ language: { code: 'de' } })).toEqual({ terms: [] });
  });

  it('holds at most the allowed number of terms', () => {
    const many = Array.from({ length: MAX_BRIEF_TERMS + 5 }, (_, i) => ({
      source: `Term ${i}`,
      target: `Terme ${i}`,
      keep: false,
    }));
    expect(sanitizeBrief({ terms: many }).terms).toHaveLength(MAX_BRIEF_TERMS);
    expect(
      mergeBriefs(
        { terms: many.slice(0, MAX_BRIEF_TERMS - 1) },
        { terms: many.slice(MAX_BRIEF_TERMS - 1) },
      ).terms,
    ).toHaveLength(MAX_BRIEF_TERMS);
  });

  it('never lets a later request change an earlier decision', () => {
    const first = {
      language: { code: 'ht', name: 'Haitian Creole', note: 'Standard Kreyòl' },
      terms: [{ source: 'Cold Chain', target: 'Cold Chain', keep: true }],
    };
    const merged = mergeBriefs(first, {
      language: { code: 'fr', name: 'French', note: '' },
      terms: [
        { source: 'cold  chain', target: 'Chèn frèt', keep: false },
        { source: 'Fleet', target: 'Flòt', keep: false },
      ],
    });
    expect(merged.language).toEqual(first.language);
    expect(merged.terms).toEqual([
      { source: 'Cold Chain', target: 'Cold Chain', keep: true },
      { source: 'Fleet', target: 'Flòt', keep: false },
    ]);
    expect(
      mergeBriefs(undefined, { language: first.language, terms: [] }),
    ).toEqual({ language: first.language, terms: [] });
  });

  it('asks only about names nothing has settled, each once', () => {
    const sentence = 'A sentence far too long to be a name '.repeat(4);
    expect(
      termCandidates(
        ['PRIM-Vax', 'prim-vax', '<b>Cold Chain</b>', 'MSF', sentence, '  '],
        ['Cold  chain'],
        10,
      ),
    ).toEqual(['PRIM-Vax', 'MSF']);
    // One character over the limit is a sentence; at the limit it is a name.
    const atLimit = 'n'.repeat(MAX_BRIEF_TERM_CHARS);
    expect(termCandidates([atLimit, `${atLimit}n`], [], 10)).toEqual([atLimit]);
    // No more than the brief can still hold.
    expect(termCandidates(['A1', 'B2', 'C3'], [], 2)).toEqual(['A1', 'B2']);
    expect(termCandidates(['A1'], [], 0)).toEqual([]);
  });
});

describe('following the brief inside a longer unit', () => {
  const who = { source: 'WHO', target: 'OMS', keep: false };
  const tic = { source: 'TIC', target: 'TIC', keep: true };
  const eco = {
    source: 'Eco and Defensive Driving',
    target: 'Conduite économique et défensive',
    keep: false,
  };

  it('finds the terms a translation does not follow', () => {
    expect(missingTerms('Ask WHO now', 'Demandez à la WHO', [who])).toEqual([
      who,
    ]);
    expect(missingTerms('Ask WHO now', 'Demandez à l’OMS', [who])).toEqual([]);
    expect(missingTerms('The TIC team', "L'équipe CTI", [tic, who])).toEqual([
      tic,
    ]);
  });

  it('matches whole words only, whatever the case or the tags', () => {
    // "WHO" is not in "whole", and "OMS" is not in "atomes".
    expect(missingTerms('The whole team', 'Toute l’équipe', [who])).toEqual([]);
    expect(missingTerms('Ask WHO', 'Des atomes', [who])).toEqual([who]);
    expect(
      missingTerms(
        'The <b>Eco and\nDefensive Driving</b> programme',
        'Le programme de <b>conduite économique et défensive</b>',
        [eco],
      ),
    ).toEqual([]);
    expect(
      missingTerms(
        'The Eco and Defensive Driving programme',
        'Le programme d’éco-conduite et de conduite défensive',
        [eco],
      ),
    ).toEqual([eco]);
  });

  it('means only the longer of two terms where one lies inside the other', () => {
    const status = { source: 'STATUS', target: 'STATUT', keep: false };
    const review = {
      source: 'Status Review',
      target: 'Revue de situation',
      keep: false,
    };
    const terms = [status, review];
    expect(termsIn('Status Review: Project X', terms)).toEqual([review]);
    expect(
      missingTerms('Status Review: X', 'Revue de situation : X', terms),
    ).toEqual([]);
    // Standing alone as well, the shorter term is meant too.
    expect(termsIn('Status Review: status is green', terms)).toEqual(terms);
    expect(termsIn('Status', terms)).toEqual([status]);
  });

  it('refuses a rewording only when it loses a term the wording had', () => {
    const source = 'Review: Eco and Defensive Driving';
    const full = 'Examen : Conduite économique et défensive';
    expect(dropsTerm(source, full, 'Examen : éco-conduite', [eco])).toBe(true);
    expect(
      dropsTerm(source, full, 'Bilan : conduite économique et défensive', [
        eco,
      ]),
    ).toBe(false);
    // A wording that never followed the term is not made worse by another.
    expect(
      dropsTerm(source, 'Examen : éco-conduite', 'Bilan : éco-conduite', [eco]),
    ).toBe(false);
  });
});

describe('editable download formats', () => {
  it('reads the known formats of a request, each once', () => {
    expect(sanitizeExportFormats(['pptx', 'pptx', 'docx', 7])).toEqual([
      'pptx',
    ]);
    expect(sanitizeExportFormats('pptx')).toEqual([]);
    expect(sanitizeExportFormats(undefined)).toEqual([]);
  });

  it('marks a presentation rebuilt from a PDF as experimental', () => {
    expect(NATIVE_PDF_EXPORT_FORMATS.pptx.experimental).toBe(true);
    expect(NATIVE_PDF_EXPORT_FORMATS.pptx.extension).toBe('pptx');
  });
});

describe('wordingInCaseOf', () => {
  it('keeps a heading in capitals in capitals', () => {
    expect(wordingInCaseOf('TIME', 'Temps')).toBe('TEMPS');
    expect(wordingInCaseOf('<b>6-MONTH REVIEW</b>', 'Revue à 6 mois')).toBe(
      'REVUE À 6 MOIS',
    );
  });

  it('leaves the wording alone for anything else', () => {
    expect(wordingInCaseOf('Time', 'Temps')).toBe('Temps');
    expect(wordingInCaseOf('time', 'Temps')).toBe('Temps');
    // No letters to tell the case by.
    expect(wordingInCaseOf('2026', 'Temps')).toBe('Temps');
  });
});

describe('breakLike', () => {
  it('puts a break where the model has one, in proportion', () => {
    expect(breakLike('DURÉE/\nAPPROUVÉE', 'DURÉE/APPROUVÉE')).toBe(
      'DURÉE/\nAPPROUVÉE',
    );
    expect(breakLike('TIME/\nAPPROVED', 'ZEIT / GENEHMIGT')).toBe(
      'ZEIT /\nGENEHMIGT',
    );
    expect(
      breakLike(
        '€ 250,000\nOCP sponsor\n2 years',
        '250 000 € Parrain OCP 2 ans',
      ),
    ).toBe('250 000 €\nParrain OCP\n2 ans');
  });

  it('leaves text alone when the model has no break', () => {
    expect(breakLike('TIME APPROVED', 'DURÉE APPROUVÉE')).toBe(
      'DURÉE APPROUVÉE',
    );
  });

  it('makes fewer breaks rather than an empty line or a split word', () => {
    // One word: nowhere a line can end.
    expect(breakLike('A\nB', 'Genehmigt')).toBe('Genehmigt');
    // Three lines wanted, one place to end a line.
    expect(breakLike('a\nb\nc', 'Zeit Genehmigt')).toBe('Zeit\nGenehmigt');
  });

  it('treats breaks already in the text as spaces', () => {
    expect(breakLike('x\ny', 'one\ntwo three')).toBe('one two\nthree');
  });
});
