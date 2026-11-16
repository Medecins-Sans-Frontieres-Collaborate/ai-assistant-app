import {
  DOCUMENT_JOB_STEPS,
  clampPage,
  correctionToSave,
  fileExtensionOf,
  leaveDocumentReader,
  parsePageInput,
  pendingPollInterval,
  showDocumentPage,
  wholeDocumentEligibility,
} from '@/lib/utils/shared/translation/documentMode';

import {
  TranslationAssessment,
  TranslationDocumentJob,
  TranslationSourceDocument,
} from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const pdf: TranslationSourceDocument = {
  name: 'Manual.PDF',
  url: '/api/file/manual.pdf',
  lastPage: 12,
  selectedPages: '1-12',
};

const job: TranslationDocumentJob = {
  jobId: 'job-1',
  status: 'ready',
  submittedAt: '2026-11-14T10:00:00.000Z',
  sourceName: 'Manual.PDF',
  translatedFilename: 'Manual_es.pdf',
  fileExtension: 'pdf',
  targetLanguage: 'es',
  pageCount: 12,
  page: 1,
};

const assessment = { edits: [] } as unknown as TranslationAssessment;

describe('fileExtensionOf', () => {
  it.each([
    ['Manual.PDF', 'pdf'],
    ['a.b.docx', 'docx'],
    ['noextension', ''],
    ['.hidden', ''],
  ])('%s -> %j', (name, expected) => {
    expect(fileExtensionOf(name)).toBe(expected);
  });
});

describe('wholeDocumentEligibility', () => {
  it('accepts a stored PDF with a supported language', () => {
    expect(wholeDocumentEligibility(pdf, 'es')).toEqual({
      ok: true,
      languageCode: 'es',
      document: pdf,
    });
  });

  it.each([
    ['no document', undefined, 'es', 'no-document'],
    [
      'a file kept only in the browser',
      { ...pdf, url: '' },
      'es',
      'no-document',
    ],
    [
      'a format without paged text',
      { ...pdf, name: 'a.docx' },
      'es',
      'unsupported-format',
    ],
    ['no language', pdf, undefined, 'no-language'],
    [
      'a language document translation lacks',
      pdf,
      'zz-not-real',
      'unsupported-language',
    ],
  ] as const)('refuses %s', (_label, document, language, reason) => {
    expect(wholeDocumentEligibility(document, language)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe('pendingPollInterval', () => {
  it('backs off at each boundary', () => {
    expect(pendingPollInterval(29_999)).toBe(2_000);
    expect(pendingPollInterval(30_000)).toBe(5_000);
    expect(pendingPollInterval(119_999)).toBe(5_000);
    expect(pendingPollInterval(120_000)).toBe(15_000);
    expect(pendingPollInterval(599_999)).toBe(15_000);
    expect(pendingPollInterval(600_000)).toBe(30_000);
  });
});

describe('page numbers', () => {
  it('clamps to the document', () => {
    expect(clampPage(0, 12)).toBe(1);
    expect(clampPage(1, 12)).toBe(1);
    expect(clampPage(12, 12)).toBe(12);
    expect(clampPage(13, 12)).toBe(12);
    expect(clampPage(3.9, 12)).toBe(3);
    expect(clampPage(Number.NaN, 12)).toBe(1);
  });

  it('does not cap when the page count is unknown', () => {
    expect(clampPage(500)).toBe(500);
  });

  it('parses only whole numbers inside the document', () => {
    expect(parsePageInput(' 12 ', 12)).toBe(12);
    expect(parsePageInput('1', 12)).toBe(1);
    expect(parsePageInput('13', 12)).toBeUndefined();
    expect(parsePageInput('0', 12)).toBeUndefined();
    expect(parsePageInput('2.5', 12)).toBeUndefined();
    expect(parsePageInput('-2', 12)).toBeUndefined();
    expect(parsePageInput('two', 12)).toBeUndefined();
    expect(parsePageInput('', 12)).toBeUndefined();
  });
});

describe('correctionToSave', () => {
  it('keeps text that differs from the machine translation', () => {
    expect(correctionToSave('1 comp.', '1 pestaña')).toBe('1 comp.');
  });

  it('removes the correction when the text matches again', () => {
    expect(correctionToSave('1 pestaña', '1 pestaña')).toBeNull();
    expect(correctionToSave(' 1 pestaña\n', '1 pestaña')).toBeNull();
  });

  it('treats an emptied page as a correction', () => {
    expect(correctionToSave('', '1 pestaña')).toBe('');
  });
});

describe('pane ownership', () => {
  it('sets the text-mode result aside the first time a page is shown', () => {
    const patch = showDocumentPage(
      { finalText: 'pasted result', assessment, documentJob: job },
      3,
      'página tres',
    );
    expect(patch).toEqual({
      finalText: 'página tres',
      assessment: undefined,
      documentJob: { ...job, page: 3, viewPage: 3 },
      textModeResult: { finalText: 'pasted result', assessment },
    });
  });

  it('does not overwrite what was set aside when turning pages', () => {
    const patch = showDocumentPage(
      {
        finalText: 'página tres',
        documentJob: { ...job, page: 4, viewPage: 3 },
        textModeResult: { finalText: 'pasted result' },
      },
      4,
      'página cuatro',
    );
    expect(patch).not.toHaveProperty('textModeResult');
    expect(patch.documentJob).toMatchObject({ page: 4, viewPage: 4 });
    expect(patch.finalText).toBe('página cuatro');
  });

  it('restores the text-mode result on leaving and remembers the page', () => {
    const patch = leaveDocumentReader({
      finalText: 'página cuatro',
      documentJob: { ...job, page: 4, viewPage: 4 },
      textModeResult: { finalText: 'pasted result', assessment },
    });
    expect(patch).toEqual({
      finalText: 'pasted result',
      assessment,
      textModeResult: undefined,
      documentJob: { ...job, page: 4, viewPage: undefined },
    });
  });

  it('changes nothing when the reader does not hold the pane', () => {
    expect(
      leaveDocumentReader({ finalText: 'pasted result', documentJob: job }),
    ).toEqual({});
    expect(leaveDocumentReader({ finalText: 'pasted result' })).toEqual({});
    expect(showDocumentPage({ finalText: 'x' }, 1, 'y')).toEqual({});
  });

  it('round-trips: show then leave gives back the original result', () => {
    const before = { finalText: 'pasted result', assessment, documentJob: job };
    const shown = { ...before, ...showDocumentPage(before, 2, 'dos') };
    const left = { ...shown, ...leaveDocumentReader(shown) };
    expect(left.finalText).toBe('pasted result');
    expect(left.assessment).toBe(assessment);
    expect(left.documentJob?.page).toBe(2);
  });
});

describe('DOCUMENT_JOB_STEPS', () => {
  it('ends on ready', () => {
    expect(DOCUMENT_JOB_STEPS[DOCUMENT_JOB_STEPS.length - 1]).toBe('ready');
  });
});
