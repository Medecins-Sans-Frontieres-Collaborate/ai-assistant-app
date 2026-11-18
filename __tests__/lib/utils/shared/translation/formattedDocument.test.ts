import {
  DEFAULT_DOCUMENT_LAYOUT,
  DOCUMENT_LAYOUTS,
  FIT_TOLERANCE,
  FormattedDocumentRun,
  applyRenderReport,
  currentTranslation,
  editedUnits,
  fitEstimate,
  formatPageSelection,
  formattedEligibility,
  issueKey,
  openIssues,
  plainText,
  retagEditedText,
  selectedPages,
  stalePages,
  togglePage,
  translationsForRender,
  unitBox,
  withUnitEdit,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NATIVE_PDF_DEFAULT_DEPTH,
  NativePdfRenderReport,
  NativePdfUnitResult,
} from '@/lib/utils/shared/translation/nativePdf';

import { describe, expect, it } from 'vitest';

const MAX_PAGES = 6;

function unit(
  id: string,
  page: number,
  translation: string | null,
  extra: Partial<NativePdfUnitResult> = {},
): NativePdfUnitResult {
  return {
    id,
    page,
    n: Number(id.split('u')[1]),
    role: 'body',
    note: '',
    source: `source ${id}`,
    bbox: [50, 100, 250, 120],
    room: [50, 100, 300, 130],
    budgetChars: 100,
    translation,
    scale: 1,
    fits: true,
    tagsRepaired: false,
    refitted: false,
    ...extra,
  };
}

function run(extra: Partial<FormattedDocumentRun> = {}): FormattedDocumentRun {
  return {
    steps: [],
    pageCount: 2,
    pages: [],
    units: [
      unit('p1u1', 1, 'Un <b>titre</b>'),
      unit('p1u2', 1, null),
      unit('p2u1', 2, 'Texte', { refitted: true, scale: 0.8 }),
    ],
    issues: [
      { page: 1, n: 1, kind: 'overflow', severity: 'major', note: 'old' },
      { page: 2, n: 1, kind: 'clipped', severity: 'minor', note: 'kept' },
    ],
    uncheckedPages: [],
    fonts: { sans: 'A', serif: 'B' },
    refitRounds: 1,
    pdfUrl: '/old.pdf',
    pageImages: [],
    sourceId: 's',
    unitsId: 'u',
    sourceUrl: '/api/file/x.pdf',
    sourceName: 'x.pdf',
    targetLanguage: 'French',
    depth: 'quick',
    finishedAt: '2026-11-18T00:00:00.000Z',
    totalTokens: 10,
    edits: {},
    page: 1,
    dismissed: [],
    ...extra,
  };
}

function renderReport(
  extra: Partial<NativePdfRenderReport> = {},
): NativePdfRenderReport {
  return {
    fits: [],
    issues: [],
    checkedPages: [],
    uncheckedPages: [],
    fonts: { sans: 'C', serif: 'D' },
    repaired: [],
    tooLong: [],
    pdfUrl: '/new.pdf',
    pageImages: [],
    ...extra,
  };
}

describe('document defaults', () => {
  it('reads documents as text and translates quickly unless told otherwise', () => {
    expect(DEFAULT_DOCUMENT_LAYOUT).toBe('text');
    expect(DOCUMENT_LAYOUTS).toContain('formatted');
    expect(NATIVE_PDF_DEFAULT_DEPTH).toBe('quick');
  });
});

describe('formattedEligibility', () => {
  const pdf = { url: '/api/file/a.pdf', name: 'Report.PDF' };

  it('accepts a stored PDF with a target language', () => {
    expect(formattedEligibility(pdf, 'French')).toEqual({ ok: true });
  });

  it('names what is missing, most basic first', () => {
    expect(formattedEligibility(undefined, 'French')).toEqual({
      ok: false,
      reason: 'no-document',
    });
    expect(formattedEligibility({ name: 'a.pdf' }, 'French')).toEqual({
      ok: false,
      reason: 'no-document',
    });
    expect(
      formattedEligibility(
        { url: '/api/file/a.docx', name: 'a.docx' },
        'French',
      ),
    ).toEqual({ ok: false, reason: 'not-pdf' });
    expect(formattedEligibility(pdf, '  ')).toEqual({
      ok: false,
      reason: 'no-language',
    });
  });
});

describe('retagEditedText', () => {
  it('leaves untagged text as typed', () => {
    expect(retagEditedText('Bonjour', 'Salut')).toEqual({
      text: 'Salut',
      dropped: 0,
    });
  });

  it('wraps a span again where its words still appear', () => {
    const previous = 'Voir <g1>le rapport</g1> de <b>2025</b>.';
    expect(plainText(previous)).toBe('Voir le rapport de 2025.');
    expect(
      retagEditedText(previous, 'Lire le rapport annuel de 2025.'),
    ).toEqual({
      text: 'Lire <g1>le rapport</g1> annuel de <b>2025</b>.',
      dropped: 0,
    });
  });

  it('drops the tag of a span whose words changed and counts it', () => {
    expect(
      retagEditedText(
        'Voir <g1>le rapport</g1> de <b>2025</b>.',
        'Voir la note de 2025.',
      ),
    ).toEqual({ text: 'Voir la note de <b>2025</b>.', dropped: 1 });
  });

  it('keeps two equal phrases in their order', () => {
    expect(retagEditedText('<b>oui</b> et <i>oui</i>', 'oui ou oui')).toEqual({
      text: '<b>oui</b> ou <i>oui</i>',
      dropped: 0,
    });
  });
});

describe('withUnitEdit', () => {
  it('records an edit and reports the unit and its page as stale', () => {
    const edited = withUnitEdit(run(), 'p2u1', 'Nouveau');
    expect(edited.edits).toEqual({ p2u1: 'Nouveau' });
    expect(currentTranslation(edited, edited.units[2])).toBe('Nouveau');
    expect(editedUnits(edited).map((u) => u.id)).toEqual(['p2u1']);
    expect(stalePages(edited)).toEqual([2]);
  });

  it('removes the entry when the text is back to what is on the page', () => {
    const edited = withUnitEdit(run(), 'p2u1', 'Nouveau');
    expect(withUnitEdit(edited, 'p2u1', ' Texte ').edits).toEqual({});
  });

  it('treats null and empty text as keep as written', () => {
    expect(withUnitEdit(run(), 'p1u1', null).edits).toEqual({ p1u1: null });
    expect(withUnitEdit(run(), 'p1u1', '   ').edits).toEqual({ p1u1: null });
    // Already kept as written: nothing to record.
    expect(withUnitEdit(run(), 'p1u2', null).edits).toEqual({});
  });

  it('ignores an unknown unit', () => {
    const before = run();
    expect(withUnitEdit(before, 'nope', 'x')).toBe(before);
  });
});

describe('translationsForRender', () => {
  it('sends edits over the rendered text and leaves kept units out', () => {
    let edited = withUnitEdit(run(), 'p1u1', null);
    edited = withUnitEdit(edited, 'p1u2', 'Traduit');
    expect(translationsForRender(edited)).toEqual({
      p1u2: 'Traduit',
      p2u1: 'Texte',
    });
  });
});

describe('applyRenderReport', () => {
  it('makes the edits the rendered text and takes the new fit', () => {
    const edited = withUnitEdit(run(), 'p2u1', 'Nouveau');
    const applied = applyRenderReport(
      edited,
      renderReport({
        fits: [{ id: 'p2u1', page: 2, n: 1, scale: 1, fits: true }],
      }),
    );
    expect(applied.edits).toEqual({});
    expect(applied.units[2]).toMatchObject({
      translation: 'Nouveau',
      scale: 1,
      refitted: false,
    });
    expect(applied.pdfUrl).toBe('/new.pdf');
    expect(applied.fonts).toEqual({ sans: 'C', serif: 'D' });
  });

  it('marks a unit that is no longer laid out as untouched', () => {
    const edited = withUnitEdit(run(), 'p1u1', null);
    const applied = applyRenderReport(edited, renderReport());
    expect(applied.units[0]).toMatchObject({
      translation: null,
      scale: null,
      fits: null,
    });
  });

  it('keeps the edit of a unit the server refused as too long', () => {
    const edited = withUnitEdit(run(), 'p2u1', 'Bien trop long');
    const applied = applyRenderReport(
      edited,
      renderReport({ tooLong: ['p2u1'] }),
    );
    expect(applied.edits).toEqual({ p2u1: 'Bien trop long' });
    expect(applied.units[2].translation).toBe('Texte');
  });

  it('replaces findings only on the pages that were checked again', () => {
    const applied = applyRenderReport(
      run(),
      renderReport({
        checkedPages: [1],
        issues: [
          { page: 1, n: 2, kind: 'overlap', severity: 'minor', note: 'new' },
        ],
      }),
    );
    expect(applied.issues.map((issue) => issue.note)).toEqual(['kept', 'new']);
  });

  it('tracks pages whose check could not run until a check succeeds', () => {
    const failed = applyRenderReport(
      run({ uncheckedPages: [1] }),
      renderReport({ uncheckedPages: [1, 2] }),
    );
    expect(failed.uncheckedPages).toEqual([1, 2]);
    const checked = applyRenderReport(
      failed,
      renderReport({ checkedPages: [1] }),
    );
    expect(checked.uncheckedPages).toEqual([2]);
  });
});

describe('openIssues', () => {
  it('hides dismissed findings and other pages', () => {
    const base = run();
    expect(openIssues(base, 1).map((issue) => issue.note)).toEqual(['old']);
    const dismissed = run({ dismissed: [issueKey(base.issues[0])] });
    expect(openIssues(dismissed, 1)).toEqual([]);
    expect(openIssues(dismissed, 2)).toHaveLength(1);
  });
});

describe('unitBox', () => {
  it('places a box as percentages of its page, with a little padding', () => {
    expect(unitBox([50, 100, 250, 120], { width: 500, height: 1000 })).toEqual({
      left: '9.600%',
      top: '9.800%',
      width: '40.800%',
      height: '2.400%',
    });
  });

  it('never leaves the page', () => {
    const box = unitBox([-10, -10, 600, 20], { width: 500, height: 1000 });
    expect(box.left).toBe('0.000%');
    expect(box.width).toBe('100.000%');
  });
});

describe('fitEstimate', () => {
  const budget = 100;
  const text = (chars: number) => 'x'.repeat(chars);

  it('does not warn at the budget or within the tolerance over it', () => {
    expect(fitEstimate(text(budget), budget).tight).toBe(false);
    expect(
      fitEstimate(text(Math.floor(budget * (1 + FIT_TOLERANCE))), budget).tight,
    ).toBe(false);
  });

  it('warns just past the tolerance', () => {
    expect(
      fitEstimate(text(Math.floor(budget * (1 + FIT_TOLERANCE)) + 1), budget)
        .tight,
    ).toBe(true);
  });

  it('counts visible characters, not tags', () => {
    expect(fitEstimate('<b>abc</b>', budget)).toMatchObject({
      chars: 3,
      budget,
    });
  });
});

describe('page selection', () => {
  it('writes runs of pages as ranges', () => {
    expect(formatPageSelection([8, 1, 3, 2, 2])).toBe('1-3, 8');
    expect(formatPageSelection([])).toBe('');
  });

  it('limits a selection to the pages the document has', () => {
    expect(selectedPages('2-5', 3, MAX_PAGES)).toEqual({
      ok: true,
      pages: [2, 3],
    });
  });

  it('refuses a selection of more pages than one run takes', () => {
    expect(selectedPages(`1-${MAX_PAGES}`, 20, MAX_PAGES).ok).toBe(true);
    expect(selectedPages(`1-${MAX_PAGES + 1}`, 20, MAX_PAGES).ok).toBe(false);
  });

  it('adds and removes a page', () => {
    expect(togglePage([1, 2], 3, MAX_PAGES)).toBe('1-3');
    expect(togglePage([1, 2, 3], 2, MAX_PAGES)).toBe('1, 3');
  });

  it('refuses a page past the limit and allows one at it', () => {
    const full = Array.from({ length: MAX_PAGES }, (_, index) => index + 1);
    expect(togglePage(full.slice(0, -1), MAX_PAGES, MAX_PAGES)).toBe(
      `1-${MAX_PAGES}`,
    );
    expect(togglePage(full, MAX_PAGES + 1, MAX_PAGES)).toBeNull();
  });

  it('keeps the last selected page, since an empty selection is not "none"', () => {
    expect(togglePage([4], 4, MAX_PAGES)).toBe('4');
  });
});
