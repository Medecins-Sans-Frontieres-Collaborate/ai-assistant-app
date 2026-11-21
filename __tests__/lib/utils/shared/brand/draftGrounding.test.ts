import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  groundDraft,
  groundingCount,
  groundingKey,
} from '@/lib/utils/shared/brand/draftGrounding';

import { describe, expect, it } from 'vitest';

/**
 * WHERE A DRAFT'S VALUES ARE STATED (draftGrounding.ts). Each kind of
 * value has one case the guide states and one it does not, and each way a
 * guide may state a colour has a near miss beside it.
 */

const PAGES = [
  { page: 1, text: 'Our name is “Northwind Health”. Never write NWH.' },
  {
    page: 4,
    text: 'Red\nHEX: #EE0000\nTeal\nR: 49 / G: 161 / B: 154\nNot a colour: 1EE00009',
  },
  {
    page: 7,
    text: 'Primary typeface: Avenir  Next. In Office use Avenir Next LT Pro.',
  },
];

function book(changes: Record<string, unknown>) {
  const parsed = parseBrandBookBody({ name: 'Northwind', ...changes });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.body;
}

describe('groundDraft', () => {
  it('finds a colour by its hex or its RGB, and not by digits inside a longer number', () => {
    const grounding = groundDraft(
      book({
        palette: [
          { name: 'Red', hex: '#ee0000' },
          { name: 'Teal', hex: '#31a19a' },
          // One digit from the stated red: stated nowhere.
          { name: 'Dark red', hex: '#ee0001' },
          // Only ever inside "1EE00009".
          { name: 'Odd', hex: '#e00009' },
        ],
        neutrals: ['#ffffff'],
      }),
      PAGES,
    );
    expect(grounding.colors).toEqual({
      '#ee0000': 4,
      '#31a19a': 4,
      '#ee0001': null,
      '#e00009': null,
      '#ffffff': null,
    });
    expect(groundingCount(grounding.colors)).toEqual({ found: 2, total: 5 });
  });

  it('finds typefaces and substitutes whatever the spacing and case', () => {
    const grounding = groundDraft(
      book({
        fonts: [
          {
            role: 'body',
            family: 'Avenir Next',
            substitutes: ['Avenir Next LT Pro', 'Arial'],
          },
        ],
      }),
      PAGES,
    );
    expect(grounding.fonts).toEqual({
      [groundingKey('Avenir Next')]: 7,
      [groundingKey('Avenir Next LT Pro')]: 7,
      [groundingKey('Arial')]: null,
    });
  });

  it('finds words and the words listed with them, across quote styles', () => {
    const grounding = groundDraft(
      book({
        language: {
          preferred: [
            {
              term: '"Northwind Health"',
              alternatives: ['Northwind Healthcare'],
            },
          ],
          banned: [{ term: 'NWH', alternatives: [] }],
        },
      }),
      PAGES,
    );
    expect(grounding.terms).toEqual({
      [groundingKey('"Northwind Health"')]: 1,
      [groundingKey('Northwind Healthcare')]: null,
      [groundingKey('NWH')]: 1,
    });
  });

  it('claims nothing about a guide without text', () => {
    const grounding = groundDraft(
      book({ palette: [{ name: 'Red', hex: '#ee0000' }] }),
      [],
    );
    expect(grounding.colors['#ee0000']).toBeNull();
  });
});
