import {
  describeBook,
  describePage,
  noteLanguage,
  pageFindings,
} from '@/lib/services/brand/brandPageReview';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  DocumentImage,
  DocumentUnit,
} from '@/lib/utils/shared/documents/documentModel';

import { describe, expect, it, vi } from 'vitest';

/** What of a model's page review is kept, and what the model is told. */

vi.mock('@/config/environment', () => ({ env: {} }));

const unit: DocumentUnit = {
  id: 'u1',
  page: 2,
  kind: 'text',
  text: 'Hello   world',
  box: [10, 10, 100, 20],
  runs: [],
};
const picture: DocumentImage = {
  id: 'img1',
  page: 2,
  box: [200, 50, 260, 110],
  name: 'badge',
  sha256: 'x',
  file: 'x.png',
  contentType: 'image/png',
};
const raw = (changes: Record<string, string>) => ({
  rule: 'tone' as const,
  severity: 'warning' as const,
  unitId: '',
  imageId: '',
  found: 'x',
  note: 'Change it.',
  ...changes,
});

describe('pageFindings', () => {
  const units = new Map([[unit.id, unit]]);
  const pictures = new Map([[picture.id, picture]]);

  it('ties a finding to its unit or picture, with its box', () => {
    const [toUnit, toPicture, toPage] = pageFindings(
      2,
      [
        raw({ unitId: 'u1' }),
        raw({ rule: 'logo-unknown', imageId: 'img1' }),
        raw({ rule: 'visual' }),
      ],
      units,
      pictures,
    );
    expect(toUnit).toMatchObject({
      unitId: 'u1',
      box: unit.box,
      source: 'model',
    });
    expect(toPicture).toMatchObject({ imageId: 'img1', box: picture.box });
    expect(toPage).toMatchObject({
      unitId: null,
      imageId: null,
      box: null,
      page: 2,
    });
  });

  it('drops a finding naming an id not on the page, or saying nothing', () => {
    expect(
      pageFindings(
        2,
        [
          raw({ unitId: 'u9' }),
          raw({ imageId: 'img9' }),
          raw({ unitId: 'u1', note: '  ' }),
        ],
        units,
        pictures,
      ),
    ).toEqual([]);
  });

  it('keeps one finding per rule and target', () => {
    expect(
      pageFindings(
        2,
        [raw({ unitId: 'u1' }), raw({ unitId: 'u1' })],
        units,
        pictures,
      ),
    ).toHaveLength(1);
  });
});

describe('what the model is told', () => {
  it('names the language of the notes, which is the reader’s', () => {
    expect(noteLanguage('en')).toBe('English');
    expect(noteLanguage('it')).toBe('Italian');
    expect(noteLanguage('pt-BR')).toBe('Brazilian Portuguese');
    // Not a tag: passed through rather than failing the page.
    expect(noteLanguage('not a tag')).toBe('not a tag');
  });

  it('states the book plainly', () => {
    const parsed = parseBrandBookBody({
      name: 'Northwind',
      palette: [{ name: 'Teal', hex: '#0f7c80', roles: ['primary'] }],
      language: { locales: ['en'], tone: 'Warm.' },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const text = describeBook(parsed.body);
    expect(text).toContain('Teal #0f7c80 (primary)');
    expect(text).toContain('Languages: en');
    expect(text).toContain('Tone: Warm.');
  });

  it('lists the page’s units and unplaced pictures by id', () => {
    const text = describePage([unit], [picture]);
    expect(text).toContain('- u1: Hello world');
    expect(text).toContain('- img1 at x 200-260 pt, y 50-110 pt (badge)');
    expect(describePage([], [])).toContain('(none)');
  });
});
