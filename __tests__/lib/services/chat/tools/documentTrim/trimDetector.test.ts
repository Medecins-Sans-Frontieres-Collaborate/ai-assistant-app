import {
  detectTrimRequest,
  pickTrimmableDocument,
} from '@/lib/services/chat/tools/documentTrim/trimDetector';

import { describe, expect, it } from 'vitest';

describe('detectTrimRequest', () => {
  describe('absolute targets', () => {
    it('detects "trim this to 6k words"', () => {
      expect(detectTrimRequest('please trim this to 6k words')).toEqual({
        kind: 'absolute',
        unit: 'words',
        target: 6000,
        approx: false,
      });
    });

    it('detects "reduce to 6,000 characters"', () => {
      expect(detectTrimRequest('reduce to 6,000 characters')).toEqual({
        kind: 'absolute',
        unit: 'characters',
        target: 6000,
        approx: false,
      });
    });

    it('detects "shorten the doc to under 5000 words"', () => {
      expect(detectTrimRequest('shorten the doc to under 5000 words')).toEqual({
        kind: 'absolute',
        unit: 'words',
        target: 5000,
        approx: false,
      });
    });

    it('detects "condense to 6000 words"', () => {
      expect(detectTrimRequest('condense to 6000 words')).toMatchObject({
        kind: 'absolute',
        unit: 'words',
        target: 6000,
      });
    });

    it('detects "bring it down to 3k chars"', () => {
      expect(detectTrimRequest('bring it down to 3k chars')).toEqual({
        kind: 'absolute',
        unit: 'characters',
        target: 3000,
        approx: false,
      });
    });

    it('detects "6 thousand words"', () => {
      expect(detectTrimRequest('cut this down to 6 thousand words')).toEqual({
        kind: 'absolute',
        unit: 'words',
        target: 6000,
        approx: false,
      });
    });

    it('marks "about" targets as approx', () => {
      expect(detectTrimRequest('trim to about 6000 words')).toEqual({
        kind: 'absolute',
        unit: 'words',
        target: 6000,
        approx: true,
      });
    });

    it('converts pages to approximate words', () => {
      expect(detectTrimRequest('cut it down to about 5 pages')).toEqual({
        kind: 'absolute',
        unit: 'words',
        target: 2500,
        approx: true,
      });
    });

    it('prefers the absolute target when a ratio phrase also appears', () => {
      expect(
        detectTrimRequest('cut this in half, say to 6000 words'),
      ).toMatchObject({ kind: 'absolute', target: 6000 });
    });
  });

  describe('ratio targets', () => {
    it('detects "cut this in half"', () => {
      expect(detectTrimRequest('cut this in half')).toEqual({
        kind: 'ratio',
        keep: 0.5,
        approx: true,
      });
    });

    it('detects "halve the document"', () => {
      expect(detectTrimRequest('halve the document')).toEqual({
        kind: 'ratio',
        keep: 0.5,
        approx: true,
      });
    });

    it('detects "make it half as long"', () => {
      expect(detectTrimRequest('make it shorter — half as long')).toEqual({
        kind: 'ratio',
        keep: 0.5,
        approx: true,
      });
    });

    it('detects "reduce by a third" (keeps two thirds)', () => {
      const result = detectTrimRequest('reduce by a third');
      expect(result?.kind).toBe('ratio');
      expect((result as { keep: number }).keep).toBeCloseTo(2 / 3);
    });

    it('detects "reduce to a third" (keeps one third)', () => {
      const result = detectTrimRequest('reduce to a third');
      expect(result?.kind).toBe('ratio');
      expect((result as { keep: number }).keep).toBeCloseTo(1 / 3);
    });

    it('detects "cut by 30%"', () => {
      const result = detectTrimRequest('cut the report by 30%');
      expect(result?.kind).toBe('ratio');
      expect((result as { keep: number }).keep).toBeCloseTo(0.7);
    });

    it('detects "shorten to 75%"', () => {
      const result = detectTrimRequest('shorten to 75%');
      expect(result?.kind).toBe('ratio');
      expect((result as { keep: number }).keep).toBeCloseTo(0.75);
    });
  });

  describe('negatives', () => {
    it.each([
      ['summarize this document'],
      ['add 6000 words to the introduction'],
      ['the doc is 6000 words long, fix the typos'],
      ['trim it a bit'], // verb without target
      ['make it under 6000'], // number without unit
      ['what is 6000 words in pages?'], // no transform verb
      [''],
      ['expand this to 6000 words? no — leave it'], // "expand" is not a trim verb
    ])('returns null for %j', (prompt) => {
      expect(detectTrimRequest(prompt)).toBeNull();
    });
  });
});

describe('pickTrimmableDocument', () => {
  it('picks a current-turn docx', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['manuscript.docx'],
        priorTurns: [],
      }),
    ).toEqual({ filename: 'manuscript.docx', format: 'docx' });
  });

  it('prefers current-turn files over prior-turn files', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['notes.md'],
        priorTurns: ['manuscript.docx'],
      }),
    ).toEqual({ filename: 'notes.md', format: 'md' });
  });

  it('falls back to prior-turn attachments (follow-up turns)', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: [],
        priorTurns: ['manuscript.docx'],
      }),
    ).toEqual({ filename: 'manuscript.docx', format: 'docx' });
  });

  it('maps .markdown to md and accepts .txt', () => {
    expect(
      pickTrimmableDocument({ currentTurn: ['a.markdown'], priorTurns: [] }),
    ).toEqual({ filename: 'a.markdown', format: 'md' });
    expect(
      pickTrimmableDocument({ currentTurn: ['b.txt'], priorTurns: [] }),
    ).toEqual({ filename: 'b.txt', format: 'txt' });
  });

  it('skips non-trimmable formats and returns null when none qualify', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['report.pdf', 'data.xlsx'],
        priorTurns: ['image.png'],
      }),
    ).toBeNull();
  });

  it('skips a PDF but takes a later docx', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['report.pdf', 'manuscript.docx'],
        priorTurns: [],
      }),
    ).toEqual({ filename: 'manuscript.docx', format: 'docx' });
  });
});
