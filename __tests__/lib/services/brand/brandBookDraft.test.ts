import {
  cleanDraft,
  guideEvidence,
  settleDraft,
} from '@/lib/services/brand/brandBookDraft';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  DocumentModel,
  DocumentRun,
} from '@/lib/utils/shared/documents/documentModel';

import { describe, expect, it, vi } from 'vitest';

/**
 * The measured half of a brand book draft (what a guide's text is set in)
 * and the cleaning of a model's answer into a book an admin can save.
 */

vi.mock('@/config/environment', () => ({ env: {} }));

const run = (
  text: string,
  font: string,
  color: string,
  size: number,
): DocumentRun => ({
  text,
  font,
  size,
  color,
  bold: false,
  italic: false,
  lang: null,
});

function guide(runs: DocumentRun[]): DocumentModel {
  return {
    scheme: 1,
    format: 'pdf',
    pageCount: 3,
    pages: [],
    units: runs.map((r, index) => ({
      id: `u${index}`,
      page: 1,
      kind: 'text',
      text: r.text,
      box: null,
      runs: [r],
    })),
    images: [],
    theme: null,
  };
}

describe('guideEvidence', () => {
  it('weights fonts by text, counting a style toward its family', () => {
    const evidence = guideEvidence(
      guide([
        run('a'.repeat(60), 'SourceSansPro-Regular', '#1B2A41', 10),
        run('b'.repeat(30), 'SourceSansPro-Bold', '#1b2a41', 10),
        run('c'.repeat(10), 'Montserrat-Bold', '#0f7c80', 28),
      ]),
    );
    expect(evidence.fonts).toEqual([
      { family: 'SourceSansPro-Bold', share: 0.9 },
      { family: 'Montserrat-Bold', share: 0.1 },
    ]);
    expect(evidence.colors).toEqual([
      { hex: '#1b2a41', share: 0.9 },
      { hex: '#0f7c80', share: 0.1 },
    ]);
    expect(evidence.pageCount).toBe(3);
  });

  it('takes the smallest size a fair share of text uses, not a stray glyph', () => {
    const evidence = guideEvidence(
      guide([
        run('x'.repeat(1000), 'Arial', '#000000', 10),
        run('y'.repeat(30), 'Arial', '#000000', 8),
        run('z', 'Arial', '#000000', 4),
      ]),
    );
    // 8 pt is 2.9 % of the text; 4 pt is 0.1 %.
    expect(evidence.smallestTextPt).toBe(8);
  });

  it('measures nothing on a guide without text', () => {
    expect(guideEvidence(guide([]))).toMatchObject({
      fonts: [],
      colors: [],
      smallestTextPt: null,
    });
  });
});

describe('cleanDraft', () => {
  const raw = {
    name: ' Northwind ',
    description: 'The Northwind brand.',
    palette: [
      { name: 'Ink', hex: '1B2A41', roles: ['text', 'text'] },
      { name: 'ink', hex: '#000', roles: [] },
      { name: 'Sea', hex: 'blue-green', roles: ['primary'] },
      { name: 'Teal', hex: '#0F7C80', roles: ['primary', 'loud'] },
    ],
    neutrals: ['#FFF', 'white', '#000000'],
    fonts: [
      { role: 'heading', family: 'Montserrat', substitutes: ['Arial', ' '] },
      { role: 'heading', family: 'Montserrat Bold', substitutes: [] },
      { role: 'heading', family: 'Other', substitutes: [] },
      { role: 'body', family: 'Source Sans Pro', substitutes: [] },
    ],
    minTextSizePt: 120,
    logoMinWidthPt: 0,
    locales: ['en', 'x'],
    preferred: [
      { term: 'families', alternatives: ['clients', 'cheap', 'Northwind'] },
      { term: 'Northwind', alternatives: [] },
    ],
    banned: [
      { term: 'cheap', alternatives: ['affordable'], note: 'Off brand.' },
      { term: ' ', alternatives: [], note: '' },
    ],
    tone: 'Warm and plain.',
  };

  it('keeps what can be a book and drops the rest', () => {
    const cleaned = cleanDraft(raw) as Record<string, unknown>;
    const parsed = parseBrandBookBody(cleaned);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.name).toBe('Northwind');
    expect(parsed.body.palette).toEqual([
      expect.objectContaining({ name: 'Ink', hex: '#1b2a41', roles: ['text'] }),
      expect.objectContaining({
        name: 'Teal',
        hex: '#0f7c80',
        roles: ['primary'],
      }),
    ]);
    expect(parsed.body.neutrals).toEqual(['#ffffff', '#000000']);
    expect(
      parsed.body.fonts.map((f) => [f.role, f.family, f.substitutes]),
    ).toEqual([
      // The same family twice in a role is kept once; a second family is kept.
      ['heading', 'Montserrat', ['Arial']],
      ['heading', 'Other', []],
      ['body', 'Source Sans Pro', []],
    ]);
    // A word the book bans, or asks for, is not also a word to replace.
    expect(parsed.body.language.preferred[0].alternatives).toEqual(['clients']);
    expect(parsed.body.minTextSizePt).toBe(72);
    expect(parsed.body.language.locales).toEqual(['en']);
    expect(parsed.body.language.banned.map((t) => t.term)).toEqual(['cheap']);
  });
});

describe('settleDraft', () => {
  const longest = 'x'.repeat(120);
  const draft = (alternatives: string[]) => ({
    name: 'Northwind',
    language: {
      banned: [
        { term: 'cheap', alternatives, note: '' },
        { term: 'clients', alternatives: ['families'], note: '' },
      ],
    },
  });

  it('keeps an alternative exactly as long as a term may be', () => {
    const settled = settleDraft(draft([longest]));
    expect(settled.dropped).toBe(0);
    expect(settled.book.language.banned[0].alternatives).toEqual([longest]);
  });

  it('drops an alternative one character too long, and only that', () => {
    const settled = settleDraft(draft([`${longest}x`, 'affordable']));
    expect(settled.dropped).toBe(1);
    expect(settled.book.language.banned).toEqual([
      { term: 'cheap', alternatives: ['affordable'], note: '' },
      { term: 'clients', alternatives: ['families'], note: '' },
    ]);
  });

  it('drops a colour named twice rather than refusing the draft', () => {
    const settled = settleDraft({
      name: 'Northwind',
      palette: [
        { name: 'Red', hex: '#ee0000' },
        { name: 'red', hex: '#e00000' },
      ],
    });
    expect(settled.dropped).toBe(1);
    expect(settled.book.palette.map((color) => color.hex)).toEqual(['#ee0000']);
  });

  it('refuses a draft whose problem is not in a list', () => {
    expect(() => settleDraft({ name: '' })).toThrow(
      /could not be made into a brand book: name/,
    );
  });
});
