import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import {
  SIZE_EPSILON_PT,
  checkDocumentText,
  judgeColor,
  languageAllowed,
  termOccurrences,
  termPattern,
} from '@/lib/utils/shared/brand/brandChecks';
import { colorDistance } from '@/lib/utils/shared/brand/brandColor';
import {
  DocumentModel,
  DocumentRun,
  DocumentUnit,
} from '@/lib/utils/shared/documents/documentModel';

import { describe, expect, it } from 'vitest';

/**
 * The deterministic brand checks. Every rule is tested on both sides of
 * its line, and every colour fixture asserts its own distance first, so
 * a fixture can never silently sit on the wrong side of a tolerance.
 */

const TEAL = '#0f7c80';

function bookWith(changes: Record<string, unknown> = {}) {
  const parsed = parseBrandBookBody({
    name: 'Northwind',
    palette: [{ name: 'Teal', hex: TEAL, tolerance: 3 }],
    fonts: [
      { role: 'heading', family: 'Montserrat' },
      { role: 'body', family: 'Source Sans Pro', substitutes: ['Arial'] },
    ],
    minTextSizePt: 9,
    language: {
      locales: ['en'],
      banned: [{ term: 'cheap', alternatives: ['affordable'] }],
      preferred: [{ term: 'families', alternatives: ['clients'] }],
    },
    ...changes,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.body;
}

function run(changes: Partial<DocumentRun> = {}): DocumentRun {
  return {
    text: 'Text',
    font: 'Source Sans Pro',
    size: 11,
    color: TEAL,
    bold: false,
    italic: false,
    lang: null,
    ...changes,
  };
}

let nextId = 0;
function unit(runs: DocumentRun[], changes: Partial<DocumentUnit> = {}) {
  nextId += 1;
  return {
    id: `u${nextId}`,
    page: 1,
    kind: 'text',
    text: runs.map((r) => r.text).join(''),
    box: [10, 10, 100, 20] as [number, number, number, number],
    runs,
    ...changes,
  };
}

function model(units: DocumentUnit[]): DocumentModel {
  return {
    scheme: 1,
    format: 'pdf',
    pageCount: 1,
    pages: [{ page: 1, width: 595, height: 842 }],
    units,
    images: [],
    theme: null,
  };
}

const rulesOf = (units: DocumentUnit[], book = bookWith()) =>
  checkDocumentText(model(units), book).map((f) => `${f.rule}:${f.found}`);

describe('fonts', () => {
  it('takes the book’s families, their styles and their substitutes', () => {
    expect(
      rulesOf([
        unit([run({ font: 'Montserrat-Bold' })]),
        unit([run({ font: 'SourceSansPro-Regular' })]),
        unit([run({ font: 'Arial' })]),
        unit([run({ font: null })]),
      ]),
    ).toEqual([]);
  });

  it('reports another font once per unit, however many runs use it', () => {
    expect(
      rulesOf([
        unit([run({ font: 'Comic Sans MS' }), run({ font: 'Comic Sans MS' })]),
      ]),
    ).toEqual(['font:Comic Sans MS']);
  });

  it('checks no fonts when the book sets none', () => {
    expect(
      rulesOf(
        [unit([run({ font: 'Comic Sans MS' })])],
        bookWith({ fonts: [] }),
      ),
    ).toEqual([]);
  });
});

describe('colours', () => {
  it('brackets the tolerance: just inside passes, just outside fails', () => {
    const inside = '#117e82';
    const outside = '#1a8f8a';
    // The fixtures sit where the test needs them.
    expect(colorDistance(inside, TEAL)).toBeLessThan(3);
    expect(colorDistance(outside, TEAL)).toBeGreaterThan(3);
    expect(colorDistance(outside, TEAL)).toBeLessThan(10);
    expect(rulesOf([unit([run({ color: inside })])])).toEqual([]);
    expect(rulesOf([unit([run({ color: outside })])])).toEqual([
      `color:${outside}`,
    ]);
  });

  it('allows a colour exactly at the tolerance', () => {
    const hex = '#1a8f8a';
    const exact = colorDistance(hex, TEAL);
    expect(judgeColor(hex, [{ hex: TEAL, tolerance: exact }]).matches).toBe(
      true,
    );
    expect(
      judgeColor(hex, [{ hex: TEAL, tolerance: exact - 0.01 }]).matches,
    ).toBe(false);
  });

  it('matches by any colour’s own tolerance, not only the nearest’s', () => {
    const hex = '#1a8f8a';
    const near = { hex: '#168a87', tolerance: 0.1 };
    const far = { hex: TEAL, tolerance: 10 };
    expect(colorDistance(hex, near.hex)).toBeLessThan(
      colorDistance(hex, far.hex),
    );
    expect(colorDistance(hex, near.hex)).toBeGreaterThan(near.tolerance);
    const judged = judgeColor(hex, [near, far]);
    expect(judged.matches).toBe(true);
    expect(judged.nearest[0]).toBe(near.hex);
  });

  it('allows the neutrals and an undeclared colour, and names the nearest', () => {
    expect(
      rulesOf([
        unit([run({ color: '#FFFFFF' })]),
        unit([run({ color: '#000000' })]),
        unit([run({ color: null })]),
      ]),
    ).toEqual([]);
    const [finding] = checkDocumentText(
      model([unit([run({ color: '#ff00ff' })])]),
      bookWith(),
    );
    expect(finding.expected[0]).toBeDefined();
    expect(finding.severity).toBe('error');
  });
});

describe('sizes', () => {
  it('brackets the minimum with its epsilon', () => {
    expect(SIZE_EPSILON_PT).toBeGreaterThan(0.001);
    expect(
      rulesOf([
        unit([run({ size: 9 })]),
        unit([run({ size: 9 - SIZE_EPSILON_PT / 2 })]),
      ]),
    ).toEqual([]);
    expect(rulesOf([unit([run({ size: 8.9 })])])).toEqual(['size:8.9']);
    expect(rulesOf([unit([run({ size: 7 })])])).toEqual(['size:7']);
  });

  it('checks no size when the book sets none', () => {
    expect(
      rulesOf([unit([run({ size: 5 })])], bookWith({ minTextSizePt: 0 })),
    ).toEqual([]);
  });
});

describe('wording', () => {
  it('finds a banned term as a word, in any case, and counts it', () => {
    const findings = checkDocumentText(
      model([unit([run({ text: 'Cheap care. Never cheap!' })])]),
      bookWith(),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'banned-term',
        found: 'cheap',
        expected: ['affordable'],
        count: 2,
      }),
    ]);
    expect(
      rulesOf([unit([run({ text: 'The cheapest cheapskate.' })])]),
    ).toEqual([]);
  });

  it('matches a phrase across any spacing but not joined up', () => {
    const pattern = termPattern('fund raising');
    expect('Fund   raising day'.match(pattern)).toHaveLength(1);
    expect('fundraising day'.match(pattern)).toBeNull();
    expect('a.b(c)'.match(termPattern('b(c)'))).toHaveLength(1);
  });

  it('suggests the preferred term for a word it replaces', () => {
    expect(
      checkDocumentText(
        model([unit([run({ text: 'Our clients come first.' })])]),
        bookWith(),
      ),
    ).toEqual([
      expect.objectContaining({
        rule: 'preferred-term',
        severity: 'warning',
        found: 'clients',
        expected: ['families'],
      }),
    ]);
  });

  it('checks a declared language by its primary subtag only', () => {
    expect(languageAllowed('en-GB', ['en'])).toBe(true);
    expect(languageAllowed('en', ['en-US'])).toBe(true);
    expect(languageAllowed('fr-CA', ['en'])).toBe(false);
    expect(
      rulesOf([
        unit([run({ lang: 'en-GB' })]),
        unit([run({ lang: null })]),
        unit([run({ lang: 'fr-FR' })]),
      ]),
    ).toEqual(['language:fr-FR']);
  });
});

describe('what is checked', () => {
  it('skips layout and master text, and checks notes for wording only', () => {
    const offBrand = run({ font: 'Comic Sans MS', text: 'Cheap' });
    expect(rulesOf([unit([offBrand], { kind: 'master' })])).toEqual([]);
    expect(rulesOf([unit([offBrand], { kind: 'layout' })])).toEqual([]);
    expect(rulesOf([unit([offBrand], { kind: 'notes', box: null })])).toEqual([
      'banned-term:cheap',
    ]);
  });

  it('ties each finding to its unit, page and box', () => {
    const u = unit([run({ font: 'Comic Sans MS' })], { page: 3 });
    const [finding] = checkDocumentText(model([u]), bookWith());
    expect(finding).toMatchObject({
      page: 3,
      unitId: u.id,
      box: u.box,
      source: 'check',
    });
  });
});

describe('termOccurrences', () => {
  it('counts a word on its own and not inside the phrase asked for', () => {
    const accepted = ['people who are homeless'];
    expect(
      termOccurrences('Care for the homeless.', 'homeless', accepted),
    ).toBe(1);
    expect(
      termOccurrences(
        'Care for people who are homeless.',
        'homeless',
        accepted,
      ),
    ).toBe(0);
    // Both in one text: only the bare one counts.
    expect(
      termOccurrences(
        'The homeless, and people who are homeless.',
        'homeless',
        accepted,
      ),
    ).toBe(1);
  });

  it('does not report a preferred name for holding the short form it replaces', () => {
    const preferred = 'Médecins Sans Frontières (MSF)';
    expect(termOccurrences(`We are ${preferred}.`, 'MSF', [preferred])).toBe(0);
    expect(termOccurrences('We are MSF.', 'MSF', [preferred])).toBe(1);
  });
});

describe('wording that overlaps', () => {
  const book = bookWith({
    language: {
      banned: [
        { term: 'in the field', alternatives: ['working in Haiti'] },
        { term: 'the field', alternatives: ['medical project'] },
      ],
      preferred: [
        { term: 'people', alternatives: ['populations'] },
        { term: 'communities', alternatives: ['populations'] },
      ],
    },
  });
  const wording = (text: string) =>
    checkDocumentText(model([unit([run({ text })])]), book)
      .filter((f) => f.rule.endsWith('-term'))
      .map((f) => `${f.rule}:${f.found}:${f.expected.join('|')}`);

  it('reports a phrase inside a longer banned phrase once, as the longer', () => {
    expect(wording('Our teams in the field.')).toEqual([
      'banned-term:in the field:working in Haiti',
    ]);
    // On its own, the shorter phrase is still found.
    expect(wording('We left the field.')).toEqual([
      'banned-term:the field:medical project',
    ]);
  });

  it('offers every preferred word for a word two of them replace, once', () => {
    expect(wording('Care for populations.')).toEqual([
      'preferred-term:populations:people|communities',
    ]);
  });
});
