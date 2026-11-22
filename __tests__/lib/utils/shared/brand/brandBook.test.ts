import {
  brandItemId,
  familiesFor,
  fontKey,
  parseBrandBookBody,
  templateTypeForFile,
} from '@/lib/utils/shared/brand/brandBook';

import { describe, expect, it } from 'vitest';

/**
 * A brand book as an admin saves it: defaults filled, colours written one
 * way, and the values that drive hard checks refused when wrong.
 */

const northwind = {
  name: 'Northwind',
  palette: [
    { name: 'Ink', hex: '1B2A41', roles: ['text'] },
    { name: 'Teal', hex: '#0f7c80', roles: ['primary'], tolerance: 2 },
  ],
  fonts: [
    { role: 'heading', family: 'Montserrat' },
    { role: 'body', family: 'Source Sans Pro', substitutes: ['Arial'] },
  ],
  minTextSizePt: 9,
  logos: [{ id: 'main', name: 'Logo', file: 'admin:brand-1/logo.png' }],
  language: { banned: [{ term: 'cheap', alternatives: ['affordable'] }] },
};

describe('parseBrandBookBody', () => {
  it('fills defaults and writes colours one way', () => {
    const parsed = parseBrandBookBody(northwind);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.palette[0]).toMatchObject({
      hex: '#1b2a41',
      tolerance: 3,
    });
    expect(parsed.body.palette[1].tolerance).toBe(2);
    expect(parsed.body.neutrals).toEqual(['#ffffff', '#000000']);
    expect(parsed.body.logos[0].aspectTolerance).toBe(0.02);
    expect(parsed.body.language.preferred).toEqual([]);
  });

  it.each([
    [
      'a colour that is not one',
      { palette: [{ name: 'X', hex: 'teal' }] },
      'palette.0.hex',
    ],
    [
      'a negative tolerance',
      { palette: [{ name: 'X', hex: '#000', tolerance: -1 }] },
      'palette.0.tolerance',
    ],
    [
      'a typeface twice in one role',
      {
        fonts: [
          { role: 'body', family: 'Avenir Next' },
          { role: 'body', family: 'AvenirNext-Bold' },
        ],
      },
      'fonts.1',
    ],
    [
      'a colour named twice',
      {
        palette: [
          { name: 'Ink', hex: '#000' },
          { name: 'ink', hex: '#111' },
        ],
      },
      'palette.1',
    ],
    [
      'a logo id with spaces',
      { logos: [{ id: 'main logo', name: 'L', file: 'f' }] },
      'logos.0.id',
    ],
  ])('refuses %s, naming where', (_label, change, path) => {
    const parsed = parseBrandBookBody({ ...northwind, ...change });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.startsWith(`${path}:`)).toBe(true);
  });

  it('refuses a book without a name', () => {
    expect(parseBrandBookBody({ ...northwind, name: ' ' }).ok).toBe(false);
  });
});

describe('fontKey and familiesFor', () => {
  it('compares names without case, spaces or a style suffix', () => {
    expect(fontKey('SourceSansPro-Bold')).toBe(fontKey('Source Sans Pro'));
    expect(fontKey('Montserrat SemiBold')).toBe('montserrat');
    expect(fontKey('Comic Sans MS')).not.toBe(fontKey('Source Sans Pro'));
  });

  it('accepts each role’s family and its substitutes, and nothing else', () => {
    const parsed = parseBrandBookBody(northwind);
    if (!parsed.ok) throw new Error(parsed.error);
    const families = familiesFor(parsed.body);
    expect(families.has(fontKey('Arial'))).toBe(true);
    expect(families.has(fontKey('Montserrat-Bold'))).toBe(true);
    expect(families.has(fontKey('Helvetica'))).toBe(false);
  });
});

describe('brandItemId and templateTypeForFile', () => {
  it('makes a schema-valid id unique among those taken', () => {
    expect(brandItemId('Main logo', [])).toBe('main-logo');
    expect(brandItemId('Main logo', ['main-logo', 'main-logo-2'])).toBe(
      'main-logo-3',
    );
    expect(brandItemId('  ***  ', [])).toBe('item');
    expect(brandItemId('Logó Négatif', [])).toBe('logo-negatif');
    expect(brandItemId('x'.repeat(80), [])).toHaveLength(34);
  });

  it('reads a template type from its file name only for template types', () => {
    expect(templateTypeForFile('Deck.POTX')).toBe('potx');
    expect(templateTypeForFile('letter.docx')).toBe('docx');
    expect(templateTypeForFile('guide.pdf')).toBeNull();
    expect(templateTypeForFile('noextension')).toBeNull();
  });
});

describe('typefaces by role', () => {
  it('takes several typefaces in a role, and one typeface in two roles', () => {
    const parsed = parseBrandBookBody({
      name: 'Northwind',
      fonts: [
        { role: 'heading', family: 'Avenir Next' },
        { role: 'body', family: 'Avenir Next' },
        { role: 'body', family: 'Bitter' },
      ],
    });
    expect(parsed.ok).toBe(true);
  });
});
