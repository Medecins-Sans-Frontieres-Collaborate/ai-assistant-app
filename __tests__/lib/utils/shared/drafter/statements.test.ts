/**
 * Sentence and clause segmentation, content keys (for clause cuts and
 * quotation insertions), the verdict key and edit ranges. The lexical
 * statement scorer that once lived beside these was removed: attribution
 * is the model's answer now (see citations.test.ts), so nothing here pins
 * a support level.
 */
import { findQuotedSpans } from '@/lib/utils/shared/drafter/core/grounding';
import {
  changedRanges,
  contentKeys,
  statementKey,
  statementSpans,
  stemLite,
} from '@/lib/utils/shared/drafter/core/statements';

import { describe, expect, it } from 'vitest';

function keysOf(text: string): string[] {
  return contentKeys(text).keys.map((key) => key.key);
}

function spansOf(text: string): string[] {
  const masked = findQuotedSpans(text).map((span) => ({
    start: span.start,
    end: span.end,
  }));
  return statementSpans(text, masked).map((range) =>
    text.slice(range.start, range.end),
  );
}

describe('statementSpans', () => {
  it('keeps abbreviations, initials and decimals in one sentence', () => {
    expect(spansOf('Dr. Amina Yusuf spoke. She left.')).toEqual([
      'Dr. Amina Yusuf spoke.',
      'She left.',
    ]);
    expect(spansOf('Room No. 5 was full. Staff left.')).toEqual([
      'Room No. 5 was full.',
      'Staff left.',
    ]);
    expect(spansOf('J. Smith arrived. Staff left.')).toEqual([
      'J. Smith arrived.',
      'Staff left.',
    ]);
    expect(spansOf('Use masks, e.g. cloth ones. Staff left.')).toEqual([
      'Use masks, e.g. cloth ones.',
      'Staff left.',
    ]);
    expect(spansOf('Rates rose 1.5% in May. Staff left.')).toEqual([
      'Rates rose 1.5% in May.',
      'Staff left.',
    ]);
  });

  it('never cuts inside a quotation', () => {
    expect(
      spansOf('She said “we left. nobody came” then. Staff left.'),
    ).toEqual(['She said “we left. nobody came” then.', 'Staff left.']);
  });

  it('splits on every sentence end and on newlines', () => {
    expect(
      spansOf('One! Two? Three… أربعة؟ 五。 Six\n- Seven\n\n  Eight'),
    ).toEqual([
      'One!',
      'Two?',
      'Three…',
      'أربعة؟',
      '五。',
      'Six',
      'Seven',
      'Eight',
    ]);
    expect(spansOf('The answer was no. Staff left the next day.')).toEqual([
      'The answer was no.',
      'Staff left the next day.',
    ]);
  });

  it('cuts clauses only when both sides keep enough content', () => {
    const left = 'The clinic treated patients all night';
    const right = 'the road stayed closed for a week';
    expect(spansOf(`${left}; ${right}`)).toEqual([`${left};`, right]);
    expect(spansOf(`${left} — ${right}`)).toEqual([`${left} —`, right]);
    expect(spansOf(`${left}, but ${right}`)).toEqual([
      `${left},`,
      `but ${right}`,
    ]);
    expect(spansOf(`${left}, and ${right}`)).toEqual([
      `${left},`,
      `and ${right}`,
    ]);
    expect(spansOf(`${left} because ${right}`)).toEqual([
      left,
      `because ${right}`,
    ]);
    expect(spansOf('doctors and nurses worked all night')).toEqual([
      'doctors and nurses worked all night',
    ]);
    expect(spansOf(`${left} and nurses`)).toEqual([`${left} and nurses`]);
  });

  it('returns raw, trimmed offsets', () => {
    const text = '  First sentence here.   Second one follows.  ';
    const spans = statementSpans(text, []);
    expect(spans.map((range) => text.slice(range.start, range.end))).toEqual([
      'First sentence here.',
      'Second one follows.',
    ]);
    expect(spans[0]).toEqual({ start: 2, end: 22 });
    expect(statementSpans('', [])).toEqual([]);
    expect(statementSpans('… … …', [])).toEqual([]);
  });
});

describe('contentKeys', () => {
  it('stems words, folds numbers and drops articles and elided prefixes', () => {
    const { keys } = contentKeys("L'hôpital a soigné 1 200 patients");
    expect(keys.map((key) => key.key).sort()).toEqual(
      ['#1200', 'hopit', 'patie', 'soign'].sort(),
    );
    expect(keys.find((key) => key.kind === 'number')).toBeDefined();
    expect(keys.every((key) => key.key !== 'l')).toBe(true);
  });

  it('yields no key for negation, scope, causal, contrast and modal words', () => {
    for (const text of ["We didn't have water", "Nous n'avons pas d'eau"]) {
      const keys = keysOf(text);
      expect(keys, text).not.toContain('didn');
      expect(keys, text).not.toContain('avons');
      expect(keys.length, text).toBeGreaterThan(0);
    }
    expect(keysOf('The clinic had no water')).toEqual(['clini', 'water']);
    // "here" is a stop word; the rest are flag words, and yield nothing.
    expect(keysOf('only here, because it will rain, but not')).toEqual([
      'rain',
    ]);
    expect(keysOf('seulement casi porque weil')).toEqual([]);
  });

  it('drops verbs of saying and bare digits', () => {
    for (const text of ['she said', 'elle raconte', 'él dijo']) {
      expect(keysOf(text), text).toEqual([]);
    }
    expect(keysOf('3 of them and 12 more')).toEqual(['#12']);
    expect(keysOf('Thank you all')).toEqual(['thank']);
    expect(keysOf('#MSF #Water https://example.org/report @msf')).toEqual([]);
  });

  it('stems inflections of one word to one key', () => {
    expect(stemLite('patients')).toBe(stemLite('patient'));
    expect(stemLite('traites')).toBe(stemLite('traitement'));
    expect(stemLite('tratados')).toBe(stemLite('tratamiento'));
    expect(stemLite('clinics')).toBe(stemLite('clinic'));
    expect(new Set(keysOf('والمستشفى المستشفى مستشفى')).size).toBe(1);
  });
});

describe('statementKey', () => {
  it('ignores typography, spacing and the marks around a sentence', () => {
    const key = statementKey('“The clinic  treated 1,200 patients in March.”');
    expect(key).toBe('the clinic treated 1,200 patients in march');
    expect(statementKey('The clinic treated 1,200 patients in March')).toBe(
      key,
    );
    expect(statementKey('The clinic treated 1,200 patients in April')).not.toBe(
      key,
    );
    expect(statementKey('x'.repeat(700))).toHaveLength(600);
  });
});

describe('changedRanges', () => {
  const before =
    'The clinic opened in March. Staff were tired. The road was closed.';

  function sentenceOf(text: string, range: { start: number; end: number }) {
    return statementSpans(text, []).findIndex(
      (span) =>
        (range.start < span.end && span.start < range.end) ||
        (range.start === range.end &&
          span.start <= range.start &&
          range.start <= span.end),
    );
  }

  it('finds an insertion, a replacement and a pure deletion', () => {
    const inserted =
      'The clinic opened in March. Staff were very tired. The road was closed.';
    const ranges = changedRanges(before, inserted);
    expect(ranges).toHaveLength(1);
    expect(inserted.slice(ranges[0].start, ranges[0].end)).toBe('very ');
    expect(sentenceOf(inserted, ranges[0])).toBe(1);

    const replaced =
      'The clinic reopened in March. Staff were tired. The road was closed.';
    const change = changedRanges(before, replaced);
    expect(change).toHaveLength(1);
    expect(sentenceOf(replaced, change[0])).toBe(0);

    const deleted = 'The clinic opened in March. The road was closed.';
    const gone = changedRanges(before, deleted);
    expect(gone).toHaveLength(1);
    expect(gone[0].start).toBe(gone[0].end);
    expect(sentenceOf(deleted, gone[0])).toBeGreaterThanOrEqual(0);
    expect(changedRanges(before, before)).toEqual([]);
  });

  it('keeps two distant edits apart', () => {
    const after =
      'The clinic reopened in March. Staff were tired. The road was open.';
    const ranges = changedRanges(before, after);
    expect(ranges).toHaveLength(2);
    expect(sentenceOf(after, ranges[0])).toBe(0);
    expect(sentenceOf(after, ranges[1])).toBe(2);
  });
});
