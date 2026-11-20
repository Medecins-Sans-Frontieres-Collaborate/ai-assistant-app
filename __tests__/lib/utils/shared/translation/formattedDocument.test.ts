import {
  MAX_PAGE_ZOOM,
  MIN_PAGE_ZOOM,
  PAGE_ZOOM_EPSILON,
  PAGE_ZOOM_LEVELS,
  nextPageZoom,
  pageBox,
  wheelPageZoom,
} from '@/lib/utils/shared/documents/pageGeometry';
import {
  DEFAULT_DOCUMENT_LAYOUT,
  DOCUMENT_LAYOUTS,
  FIT_TOLERANCE,
  FormattedDocumentRun,
  applyRenderReport,
  batchPageState,
  changedUnits,
  combineRuns,
  currentTranslation,
  editedUnits,
  fitEstimate,
  formatPageSelection,
  formattedEligibility,
  issueKey,
  movedBox,
  openIssues,
  plainText,
  planBatch,
  planTickedBatch,
  removalPending,
  removedPages,
  restyledUnits,
  retagEditedText,
  runFromReport,
  sameUnitStyle,
  selectedPages,
  stalePages,
  textRows,
  togglePage,
  translatedPages,
  translationsForRender,
  unitStyle,
  withPageRemoved,
  withUnitEdit,
  withUnitStyle,
} from '@/lib/utils/shared/translation/formattedDocument';
import {
  NATIVE_PDF_DEFAULT_DEPTH,
  NativePdfLimits,
  NativePdfRenderReport,
  NativePdfRunReport,
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
    unitsId: 'u',
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
    ).toEqual({ ok: false, reason: 'unsupported-format' });
    // Presentations are taken, .ppt included (converted by the server).
    for (const name of ['a.pptx', 'a.PPTM', 'a.ppsx', 'a.potx', 'a.ppt']) {
      expect(
        formattedEligibility({ url: `/api/file/${name}`, name }, 'French'),
      ).toEqual({ ok: true });
    }
    // An OpenDocument presentation is not.
    expect(
      formattedEligibility({ url: '/api/file/a.odp', name: 'a.odp' }, 'French'),
    ).toEqual({ ok: false, reason: 'unsupported-format' });
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
  it('keeps only the editable files the render built', () => {
    const built = applyRenderReport(
      run(),
      renderReport({ exportUrls: { pptx: '/files/deck.pptx' } }),
    );
    expect(built.exportUrls).toEqual({ pptx: '/files/deck.pptx' });
    // A later render that was not asked for one leaves none: the stored
    // file would describe an older page.
    expect(applyRenderReport(built, renderReport()).exportUrls).toBeUndefined();
  });

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

describe('pageBox', () => {
  it('places a box as percentages of its page, with a little padding', () => {
    expect(pageBox([50, 100, 250, 120], { width: 500, height: 1000 })).toEqual({
      left: '9.600%',
      top: '9.800%',
      width: '40.800%',
      height: '2.400%',
    });
  });

  it('never leaves the page', () => {
    const box = pageBox([-10, -10, 600, 20], { width: 500, height: 1000 });
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

describe('planBatch', () => {
  // 5 a batch by default, 8 at most, 12 of a document in total.
  const limits: NativePdfLimits = {
    defaultBatchPages: 5,
    maxBatchPages: 8,
    maxDocumentPages: 12,
  };
  const plan = (input: Partial<Parameters<typeof planBatch>[0]> = {}) =>
    planBatch({ spec: '', pageCount: 20, translated: [], limits, ...input });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it('takes the first pages, as many as the default batch', () => {
    expect(plan()).toMatchObject({
      pages: [1, 2, 3, 4, 5],
      batchPages: 5,
      capacity: 5,
      allowance: 12,
    });
    expect(plan().problem).toBeUndefined();
  });

  it('holds the batch size the person asked for inside the limits', () => {
    // One under, at, and one over the largest batch; and below one.
    expect(plan({ batchPages: 7 }).batchPages).toBe(7);
    expect(plan({ batchPages: 8 }).batchPages).toBe(8);
    expect(plan({ batchPages: 9 }).batchPages).toBe(8);
    expect(plan({ batchPages: 0 }).batchPages).toBe(1);
  });

  it('continues after the pages already translated', () => {
    const next = plan({ translated: [1, 2, 3, 4, 5] });
    expect(next.pages).toEqual([6, 7, 8, 9, 10]);
    expect(next.allowance).toBe(7);
  });

  it('shrinks the batch to what the document limit leaves', () => {
    // 10 of 12 done: 2 left, less than a batch.
    expect(plan({ translated: range(1, 10) })).toMatchObject({
      pages: [11, 12],
      capacity: 2,
      allowance: 2,
    });
    // 11 done: exactly one left.
    expect(plan({ translated: range(1, 11) }).pages).toEqual([12]);
    // At the limit: nothing can be planned.
    expect(plan({ translated: range(1, 12) })).toMatchObject({
      pages: [],
      capacity: 0,
      allowance: 0,
      problem: 'none-left',
    });
  });

  it('accepts a typed selection up to the batch and refuses one page more', () => {
    expect(plan({ spec: '3-7' }).pages).toEqual([3, 4, 5, 6, 7]);
    expect(plan({ spec: '3-8' })).toMatchObject({
      pages: [],
      problem: 'over-batch',
      asked: 6,
    });
  });

  it('leaves translated pages and pages the document lacks out of a selection', () => {
    expect(plan({ spec: '1-6', translated: [1, 2] }).pages).toEqual([
      3, 4, 5, 6,
    ]);
    expect(plan({ spec: '19-25' }).pages).toEqual([19, 20]);
    expect(plan({ spec: '1-2', translated: [1, 2] }).problem).toBe('none-left');
  });

  it('says so when the selection cannot be read', () => {
    expect(plan({ spec: 'three' }).problem).toBe('unreadable');
    // An absurd range is refused instead of being counted out.
    expect(plan({ spec: '1-999999999' }).problem).toBe('unreadable');
  });

  it('plans nothing while the page count is unknown', () => {
    expect(plan({ pageCount: 0 })).toMatchObject({
      pages: [],
      problem: 'none-left',
    });
  });
});

describe('batchPageState', () => {
  const limits: NativePdfLimits = {
    defaultBatchPages: 2,
    maxBatchPages: 3,
    maxDocumentPages: 4,
  };
  const states = (input: Partial<Parameters<typeof planBatch>[0]>) => {
    const plan = planBatch({
      spec: '',
      pageCount: 6,
      translated: [],
      limits,
      ...input,
    });
    return [1, 2, 3, 4, 5, 6].map((page) => batchPageState(plan, page));
  };

  it('offers every other page while the batch has room', () => {
    expect(states({ spec: '2' })).toEqual([
      'available',
      'selected',
      'available',
      'available',
      'available',
      'available',
    ]);
  });

  it('shows the rest as waiting once the batch is full and the limit has room', () => {
    // 2 selected of a 4-page allowance.
    expect(states({})).toEqual([
      'selected',
      'selected',
      'later',
      'later',
      'later',
      'later',
    ]);
  });

  it('locks the rest once this batch uses up the document limit', () => {
    // 2 done + 2 selected = 4, the limit: one page fewer done would still
    // leave room (see the case above with a larger batch below).
    expect(states({ translated: [1, 2] })).toEqual([
      'translated',
      'translated',
      'selected',
      'selected',
      'locked',
      'locked',
    ]);
    // 1 done, 2 selected: 3 of 4, so one more can follow in a later batch.
    expect(states({ translated: [1] })).toEqual([
      'translated',
      'selected',
      'selected',
      'later',
      'later',
      'later',
    ]);
  });

  it('locks everything untranslated when the limit is already reached', () => {
    expect(states({ translated: [1, 2, 3, 4] })).toEqual([
      'translated',
      'translated',
      'translated',
      'translated',
      'locked',
      'locked',
    ]);
  });
});

describe('combineRuns', () => {
  const piece = (
    pages: number[],
    extra: Partial<FormattedDocumentRun> = {},
  ): FormattedDocumentRun =>
    run({
      pages: pages.map((page) => ({
        page,
        width: 500,
        height: 700,
        units: 1,
        textChars: 10,
        scanned: false,
      })),
      units: pages.map((page) => unit(`p${page}u1`, page, `text ${page}`)),
      pageImages: pages.map((page) => ({
        page,
        previewUrl: `/p${page}.png`,
        checkUrl: '',
      })),
      issues: [],
      uncheckedPages: [],
      edits: {},
      totalTokens: 100,
      unitsId: `units-${pages.join('-')}`,
      page: pages[0],
      ...extra,
    });

  it("keeps each batch's looks, and a page translated again starts from its new ones", () => {
    const base = piece([1, 2], {
      styles: { p1u1: { size: 9 }, p2u1: { dx: 4 } },
      pdfStyles: { p1u1: { size: 9 }, p2u1: { dx: 4 } },
    });
    // Page 2 again, this time with a different automatic fix, and page 3.
    const again = piece([2, 3], {
      styles: { p3u1: { dy: 6 } },
      pdfStyles: { p3u1: { dy: 6 } },
    });
    const joined = combineRuns(base, [again]);
    expect(joined.styles).toEqual({ p1u1: { size: 9 }, p3u1: { dy: 6 } });
    expect(joined.pdfStyles).toEqual(joined.styles);
  });

  it('returns a single piece as it is', () => {
    const only = piece([1, 2]);
    expect(combineRuns(undefined, [only])).toBe(only);
  });

  it('refuses to join nothing', () => {
    expect(() => combineRuns(undefined, [])).toThrow();
  });

  it('joins a new batch onto the earlier ones in page order', () => {
    const base = piece([3, 4], {
      edits: { p3u1: 'edited' },
      issues: [
        { page: 4, n: 1, kind: 'overflow', severity: 'minor', note: 'kept' },
      ],
    });
    const joined = combineRuns(base, [piece([1, 2]), piece([5])]);
    expect(translatedPages(joined)).toEqual([1, 2, 3, 4, 5]);
    expect(joined.units.map((u) => u.id)).toEqual([
      'p1u1',
      'p2u1',
      'p3u1',
      'p4u1',
      'p5u1',
    ]);
    expect(joined.pageImages.map((image) => image.page)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(joined.pages.map((page) => page.page)).toEqual([1, 2, 3, 4, 5]);
    // Earlier pages keep their pending edits and findings.
    expect(joined.edits).toEqual({ p3u1: 'edited' });
    expect(joined.issues).toHaveLength(1);
    expect(joined.totalTokens).toBe(300);
    // The person lands on the new batch's first page.
    expect(joined.page).toBe(1);
    expect(joined.batches).toBe(2);
  });

  it('takes a page translated again from the later piece only', () => {
    const base = piece([1, 2], {
      edits: { p1u1: 'old edit', p2u1: 'kept edit' },
      issues: [
        { page: 1, n: 1, kind: 'overflow', severity: 'major', note: 'old' },
        { page: 2, n: 1, kind: 'clipped', severity: 'minor', note: 'kept' },
      ],
      uncheckedPages: [1],
    });
    const again = piece([1], {
      units: [unit('p1u1', 1, 'new text')],
    });
    const joined = combineRuns(base, [again]);
    expect(joined.units.map((u) => u.translation)).toEqual([
      'new text',
      'text 2',
    ]);
    expect(joined.edits).toEqual({ p2u1: 'kept edit' });
    expect(joined.issues.map((issue) => issue.note)).toEqual(['kept']);
    expect(joined.uncheckedPages).toEqual([]);
  });

  it('counts batches across several additions', () => {
    const two = combineRuns(piece([1]), [piece([2])]);
    expect(combineRuns(two, [piece([3])]).batches).toBe(3);
  });
});

describe('applyRenderReport with batches', () => {
  it('keeps the images of pages the render did not draw and takes the new extraction', () => {
    const before = run({
      pageImages: [
        { page: 1, previewUrl: '/old1.png', checkUrl: '' },
        { page: 2, previewUrl: '/old2.png', checkUrl: '' },
      ],
    });
    const after = applyRenderReport(
      before,
      renderReport({
        pageImages: [{ page: 2, previewUrl: '/new2.png', checkUrl: '' }],
        unitsId: 'units-joined',
      }),
    );
    expect(after.pageImages).toEqual([
      { page: 1, previewUrl: '/old1.png', checkUrl: '' },
      { page: 2, previewUrl: '/new2.png', checkUrl: '' },
    ]);
    expect(after.unitsId).toBe('units-joined');
  });
});

describe('pages removed from the download', () => {
  it('lists removed pages once each, ascending', () => {
    expect(removedPages(run({ removedPages: [4, 2, 4] }))).toEqual([2, 4]);
    expect(removedPages(run())).toEqual([]);
    expect(removedPages(undefined)).toEqual([]);
  });

  it('removes a page and puts it back', () => {
    const without = withPageRemoved(run(), 3, true, 5);
    expect(without.removedPages).toEqual([3]);
    expect(withPageRemoved(without, 3, false, 5).removedPages).toEqual([]);
    // Removing what is removed, or restoring what is there, changes nothing.
    expect(withPageRemoved(without, 3, true, 5)).toBe(without);
    expect(withPageRemoved(run(), 3, false, 5)).toEqual(run());
  });

  it('keeps the last page: one may go from two, none from one', () => {
    const two = withPageRemoved(run(), 1, true, 3);
    const one = withPageRemoved(two, 2, true, 3);
    expect(one.removedPages).toEqual([1, 2]);
    // Page 3 is all that is left of a 3-page document.
    expect(withPageRemoved(one, 3, true, 3)).toBe(one);
  });

  it('is pending exactly while the PDF leaves out other pages than asked', () => {
    expect(removalPending(run())).toBe(false);
    expect(removalPending(run({ removedPages: [2] }))).toBe(true);
    expect(
      removalPending(run({ removedPages: [2, 4], pdfRemovedPages: [4, 2] })),
    ).toBe(false);
    // Put back since the last render.
    expect(
      removalPending(run({ removedPages: [], pdfRemovedPages: [2] })),
    ).toBe(true);
    // Same count, other pages.
    expect(
      removalPending(run({ removedPages: [2], pdfRemovedPages: [3] })),
    ).toBe(true);
  });

  it('a render makes the PDF leave out what the run asked for', () => {
    const rendered = applyRenderReport(
      run({ removedPages: [2], pdfRemovedPages: [] }),
      renderReport(),
    );
    expect(rendered.pdfRemovedPages).toEqual([2]);
    expect(removalPending(rendered)).toBe(false);
  });

  it('adding a batch keeps the removed pages of the run it adds to', () => {
    const base = run({ removedPages: [2], pdfRemovedPages: [2] });
    const piece = run({
      pages: [{ page: 3, width: 1, height: 1, units: 1, scanned: false }],
      units: [unit('p3u1', 3, 'Trois')],
      issues: [],
    });
    expect(combineRuns(base, [piece])).toMatchObject({
      removedPages: [2],
      pdfRemovedPages: [2],
    });
  });
});

describe('batches and removed pages', () => {
  // 2 a batch by default, 3 at most, 4 of a document in total.
  const limits: NativePdfLimits = {
    defaultBatchPages: 2,
    maxBatchPages: 3,
    maxDocumentPages: 4,
  };

  it('never puts a removed page in a batch, by default or by name', () => {
    const base = { pageCount: 6, translated: [1], removed: [2, 3], limits };
    expect(planBatch({ ...base, spec: '' }).pages).toEqual([4, 5]);
    expect(planBatch({ ...base, spec: '2-4' }).pages).toEqual([4]);
    expect(planBatch({ ...base, spec: '2-3' })).toMatchObject({
      pages: [],
      problem: 'none-left',
    });
  });

  it('shows a removed page as removed, translated or not', () => {
    const plan = planBatch({
      spec: '',
      pageCount: 6,
      translated: [1, 2],
      removed: [2, 5],
      limits,
    });
    expect(
      [1, 2, 3, 4, 5, 6].map((page) => batchPageState(plan, page)),
    ).toEqual([
      'translated',
      'removed',
      'selected',
      'selected',
      'removed',
      'locked',
    ]);
  });

  it('a removed translated page still counts toward the document limit', () => {
    const plan = planBatch({
      spec: '',
      pageCount: 9,
      translated: [1, 2, 3],
      removed: [3],
      limits,
    });
    expect(plan.allowance).toBe(1);
    expect(plan.pages).toEqual([4]);
  });
});

describe('planTickedBatch', () => {
  const limits: NativePdfLimits = {
    defaultBatchPages: 2,
    maxBatchPages: 3,
    maxDocumentPages: 4,
  };
  const ticked = (pages: number[], extra: { batchPages?: number } = {}) =>
    planTickedBatch({
      ticked: pages,
      pageCount: 8,
      translated: [1],
      removed: [2],
      limits,
      ...extra,
    });

  it('ticking nothing is an empty batch with room in it', () => {
    const plan = ticked([]);
    expect(plan.pages).toEqual([]);
    expect(plan.problem).toBeUndefined();
    expect(plan.capacity).toBe(2);
    expect(batchPageState(plan, 3)).toBe('available');
  });

  it('takes the ticked pages a batch can take, in page order', () => {
    // 1 is translated, 2 removed, 9 outside the document.
    expect(ticked([5, 1, 2, 9, 3]).pages).toEqual([3, 5]);
  });

  it('holds exactly the batch: a page more is left out, and the rest wait', () => {
    const full = ticked([3, 4]);
    expect(full.pages).toEqual([3, 4]);
    expect(batchPageState(full, 5)).toBe('later');
    expect(ticked([3, 4, 5]).pages).toEqual([3, 4]);
    // The person's larger batch takes the third page.
    expect(ticked([3, 4, 5], { batchPages: 3 }).pages).toEqual([3, 4, 5]);
  });

  it('locks the pages the document limit leaves no room for', () => {
    // 1 done of 4: this batch of 3 uses the limit up.
    const plan = ticked([3, 4, 5], { batchPages: 3 });
    expect(batchPageState(plan, 6)).toBe('locked');
  });
});

describe("a block's look", () => {
  // p1u1 is set in 10 pt dark blue in the source.
  const styledRun = (extra: Partial<FormattedDocumentRun> = {}) =>
    run({
      units: [
        unit('p1u1', 1, 'Un titre', { size: 10, color: '#02024F' }),
        unit('p2u1', 2, 'Texte', { size: 9, color: '#000000' }),
      ],
      ...extra,
    });

  it('has no look of its own until one is set', () => {
    expect(unitStyle(styledRun(), 'p1u1')).toEqual({});
    expect(restyledUnits(styledRun())).toEqual([]);
  });

  it('sets fields one at a time and keeps the others', () => {
    let next = withUnitStyle(styledRun(), 'p1u1', { size: 12 });
    next = withUnitStyle(next, 'p1u1', { dx: 4 });
    next = withUnitStyle(next, 'p1u1', { color: '#FF0000' });
    expect(unitStyle(next, 'p1u1')).toEqual({
      size: 12,
      dx: 4,
      color: '#ff0000',
    });
    expect(restyledUnits(next).map((u) => u.id)).toEqual(['p1u1']);
  });

  it("does not keep a size or colour equal to the source's as a change", () => {
    const resized = withUnitStyle(styledRun(), 'p1u1', { size: 10.5 });
    expect(unitStyle(resized, 'p1u1')).toEqual({ size: 10.5 });
    // Back to the source's 10 pt, and its colour in another case.
    const back = withUnitStyle(resized, 'p1u1', { size: 10, color: '#02024f' });
    expect(back.styles).toEqual({});
    expect(restyledUnits(back)).toEqual([]);
  });

  it('puts a field back with undefined, a move back with zero, and all back with null', () => {
    const styled = withUnitStyle(styledRun(), 'p1u1', {
      size: 12,
      dx: 4,
      dy: 2,
    });
    expect(
      unitStyle(withUnitStyle(styled, 'p1u1', { size: undefined }), 'p1u1'),
    ).toEqual({ dx: 4, dy: 2 });
    expect(unitStyle(withUnitStyle(styled, 'p1u1', { dx: 0 }), 'p1u1')).toEqual(
      {
        size: 12,
        dy: 2,
      },
    );
    expect(withUnitStyle(styled, 'p1u1', null).styles).toEqual({});
  });

  it('holds a size inside its range and ignores a unit it does not have', () => {
    expect(
      unitStyle(withUnitStyle(styledRun(), 'p1u1', { size: 500 }), 'p1u1').size,
    ).toBe(96);
    const same = styledRun();
    expect(withUnitStyle(same, 'nope', { size: 12 })).toBe(same);
  });

  it('compares looks field by field, absent equal to empty', () => {
    expect(sameUnitStyle(undefined, {})).toBe(true);
    expect(sameUnitStyle({ size: 12 }, { size: 12 })).toBe(true);
    expect(sameUnitStyle({ size: 12 }, { size: 12, dx: 2 })).toBe(false);
    expect(sameUnitStyle({ color: '#000000' }, undefined)).toBe(false);
  });

  it('is pending until a render uses it, and marks its page stale', () => {
    const styled = withUnitStyle(styledRun(), 'p2u1', { dy: -6 });
    expect(stalePages(styled)).toEqual([2]);
    const rendered = applyRenderReport(styled, renderReport());
    expect(rendered.pdfStyles).toEqual({ p2u1: { dy: -6 } });
    expect(restyledUnits(rendered)).toEqual([]);
    expect(stalePages(rendered)).toEqual([]);
    // Taking the look away again is a change of its own.
    const reset = withUnitStyle(rendered, 'p2u1', null);
    expect(restyledUnits(reset).map((u) => u.id)).toEqual(['p2u1']);
  });

  it('counts a block changed in text and look once', () => {
    const both = withUnitStyle(
      withUnitEdit(styledRun(), 'p1u1', 'Autre titre'),
      'p1u1',
      { size: 12 },
    );
    const other = withUnitStyle(both, 'p2u1', { dx: 2 });
    expect(changedUnits(other).map((u) => u.id)).toEqual(['p1u1', 'p2u1']);
    expect(stalePages(other)).toEqual([1, 2]);
  });

  it('moves a box right and down for positive moves', () => {
    expect(movedBox([10, 20, 30, 40], { dx: 5, dy: -3 })).toEqual([
      15, 17, 35, 37,
    ]);
    expect(movedBox([10, 20, 30, 40], undefined)).toEqual([10, 20, 30, 40]);
  });
});

describe('nextPageZoom', () => {
  const first = PAGE_ZOOM_LEVELS[0];
  const last = PAGE_ZOOM_LEVELS[PAGE_ZOOM_LEVELS.length - 1];

  it('steps through the levels in both directions', () => {
    expect(nextPageZoom(1, 1)).toBe(1.25);
    expect(nextPageZoom(1, -1)).toBe(0.75);
  });

  it('stays at either end', () => {
    expect(nextPageZoom(last, 1)).toBe(last);
    expect(nextPageZoom(first, -1)).toBe(first);
  });

  it('goes to the nearest level from a value between two', () => {
    expect(nextPageZoom(1.1, 1)).toBe(1.25);
    expect(nextPageZoom(1.1, -1)).toBe(1);
  });

  // A pinch can stop a hair either side of a level; that is the level, so
  // the next step must leave it rather than land on it again.
  it('treats a value within the tolerance of a level as that level', () => {
    const near = PAGE_ZOOM_EPSILON / 2;
    expect(nextPageZoom(1.25 - near, 1)).toBe(1.5);
    expect(nextPageZoom(1.25 + near, -1)).toBe(1);
    // Just outside the tolerance it is between two levels again.
    const outside = PAGE_ZOOM_EPSILON * 2;
    expect(nextPageZoom(1.25 - outside, 1)).toBe(1.25);
    expect(nextPageZoom(1.25 + outside, -1)).toBe(1.25);
  });
});

describe('wheelPageZoom', () => {
  it('zooms in for wheel up (negative delta) and out for wheel down', () => {
    expect(wheelPageZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelPageZoom(1, 100)).toBeLessThan(1);
    expect(wheelPageZoom(1, 0)).toBe(1);
  });

  it('undoes itself: up then down by the same amount comes back', () => {
    expect(wheelPageZoom(wheelPageZoom(1, -60), 60)).toBeCloseTo(1, 10);
  });

  it('stays within the smallest and largest zoom', () => {
    expect(wheelPageZoom(MAX_PAGE_ZOOM, -10_000)).toBe(MAX_PAGE_ZOOM);
    expect(wheelPageZoom(MIN_PAGE_ZOOM, 10_000)).toBe(MIN_PAGE_ZOOM);
  });
});

describe('runFromReport: looks set by the automatic fixes', () => {
  const report = (
    styles?: NativePdfRunReport['styles'],
  ): NativePdfRunReport => ({
    steps: [],
    pageCount: 1,
    pages: [],
    units: [unit('p1u1', 1, 'Un titre', { size: 10 })],
    issues: [],
    uncheckedPages: [],
    fonts: { sans: 'A', serif: 'B' },
    refitRounds: 1,
    styles,
    pdfUrl: '/out.pdf',
    pageImages: [],
    sourceId: 's',
    unitsId: 'u',
  });
  const meta = {
    sourceUrl: '/s.pdf',
    sourceName: 's.pdf',
    targetLanguage: 'fr',
    depth: 'quick' as const,
    totalTokens: 0,
  };

  it('are both wanted and on the page, so nothing is pending', () => {
    const made = runFromReport(report({ p1u1: { size: 9, dy: 4 } }), meta);
    expect(unitStyle(made, 'p1u1')).toEqual({ size: 9, dy: 4 });
    expect(restyledUnits(made)).toEqual([]);
    // Taking an automatic fix back is a change like any other.
    const reset = withUnitStyle(made, 'p1u1', null);
    expect(restyledUnits(reset).map((u) => u.id)).toEqual(['p1u1']);
  });

  it('are empty for a report without any', () => {
    const made = runFromReport(report(undefined), meta);
    expect(made.styles).toEqual({});
    expect(made.pdfStyles).toEqual({});
  });
});

describe('textRows', () => {
  const limits = { min: 1, max: 10 };

  it('gives each line of a text at least a row', () => {
    expect(textRows('TIME/\nAPPROVED', 50, limits)).toBe(2);
    // An empty line, as two breaks in a row make, is a row too.
    expect(textRows('a\n\nb', 50, limits)).toBe(3);
  });

  it('gives a long line the rows its characters fill', () => {
    expect(textRows('x'.repeat(101), 50, limits)).toBe(3);
    expect(textRows(`${'x'.repeat(60)}\nshort`, 50, limits)).toBe(3);
  });

  it('keeps within its limits', () => {
    expect(textRows('', 50, { min: 2, max: 12 })).toBe(2);
    expect(textRows('a\n'.repeat(30), 50, limits)).toBe(10);
  });
});
