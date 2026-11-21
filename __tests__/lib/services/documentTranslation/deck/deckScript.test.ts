import { DECK_ENGINE_SOURCE } from '@/lib/services/documents/model/deckEngineScript';

import {
  deckScriptAvailable,
  jobInput,
  runDeckScript,
  withDeckModule,
} from '../../../../helpers/deckScript';

import { strFromU8, unzipSync, zipSync } from 'fflate';
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The presentation sandbox script, run as shipped. native.pptx is described
 * in make_native_fixture.py: one feature per slide.
 */

const FIXTURES = path.join(__dirname, '../../../../fixtures/pptx');
const NATIVE = fs.readFileSync(path.join(FIXTURES, 'native.pptx'));

interface Unit {
  id: string;
  page: number;
  n: number;
  text: string;
  size: number;
  tags: Record<string, unknown>;
  bbox: number[];
  deck: { kind: string; notes?: boolean; path: number[]; copies: unknown[] };
}
interface Extraction {
  pageCount: number;
  pages: Array<{ page: number; hidden: boolean }>;
  units: Unit[];
}
interface Fit {
  id: string;
  page: number;
  scale: number;
  fits: boolean;
  kept?: boolean;
}

const source = (data: Uint8Array = NATIVE) => ({
  filename: 'source.pptx',
  data: Buffer.from(data),
});

function extract(job: Record<string, unknown> = {}, data?: Uint8Array) {
  const files = runDeckScript('extract', [
    source(data),
    jobInput({ source: 'source.pptx', pages: [], notes: true, ...job }),
  ]);
  if (files.has('refused.json')) {
    return { refused: JSON.parse(strFromU8(files.get('refused.json')!)) };
  }
  return {
    extraction: JSON.parse(strFromU8(files.get('units.json')!)) as Extraction,
    unitsFile: files.get('units.json')!,
  };
}

function rebuild(
  unitsFile: Uint8Array,
  translations: Record<string, string>,
  job: Record<string, unknown> = {},
) {
  const files = runDeckScript('rebuild', [
    source(),
    { filename: 'units.json', data: Buffer.from(unitsFile) },
    jobInput({
      source: 'source.pptx',
      units: 'units.json',
      translations,
      ...job,
    }),
  ]);
  return {
    deck: files.get('translated.pptx')!,
    report: JSON.parse(strFromU8(files.get('report.json')!)) as {
      units: Fit[];
      written: string[];
      kept: Array<{ id: string }>;
    },
  };
}

const parts = (deck: Uint8Array) => unzipSync(new Uint8Array(deck));
const xml = (deck: Uint8Array, name: string) => strFromU8(parts(deck)[name]);
const texts = (doc: string) =>
  [...doc.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);

it('ships as a raw template without backticks or dollar-braces', () => {
  expect(DECK_ENGINE_SOURCE).not.toContain('`');
  expect(DECK_ENGINE_SOURCE).not.toContain('${');
  expect(DECK_ENGINE_SOURCE.startsWith('"""The presentation engine')).toBe(
    true,
  );
});

describe.skipIf(!deckScriptAvailable)(
  'the deck script (needs python3 with lxml)',
  () => {
    let extraction: Extraction;
    let unitsFile: Uint8Array;
    const unit = (text: string) => {
      const found = extraction.units.find((u) => u.text === text);
      if (!found) throw new Error(`no unit ${text}`);
      return found;
    };

    beforeAll(() => {
      const result = extract();
      extraction = result.extraction!;
      unitsFile = result.unitsFile!;
    });

    describe('extract', () => {
      it('numbers pages as slides, hidden ones included and marked', () => {
        expect(extraction.pageCount).toBe(9);
        expect(extraction.pages.map((p) => p.hidden)).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
          true,
          false,
          false,
        ]);
        expect(unit('Hidden slide').page).toBe(7);
      });

      it('finds text in every kind of place, each paragraph its own unit', () => {
        const kinds = Object.fromEntries(
          extraction.units.map((u) => [u.text, u.deck.kind]),
        );
        expect(kinds).toMatchObject({
          'Annual report': 'slide',
          'The clinic opened in March.': 'slide',
          'Text inside two groups': 'slide',
          'Spending in 2026': 'table',
          Medicine: 'table',
          'Spending by region': 'chart',
          North: 'value',
          Spending: 'value',
          'Plan the visit': 'diagram',
          'Shown by new readers': 'slide',
          'Remember to thank the volunteers.': 'notes',
          Confidential: 'master',
        });
        // The merged-away table cell has no unit; master prompts are never read.
        expect(
          extraction.units.filter((u) => u.deck.kind === 'table'),
        ).toHaveLength(5);
        expect(
          extraction.units.some((u) => u.text.startsWith('Click to edit')),
        ).toBe(false);
      });

      it('reads master text once, with the first slide that shows it', () => {
        const marks = extraction.units.filter((u) => u.text === 'Confidential');
        expect(marks).toHaveLength(1);
        expect(marks[0].page).toBe(1);
        const later = extract({ pages: [3] }).extraction!;
        expect(later.units.some((u) => u.text === 'Confidential')).toBe(false);
      });

      it('keeps fields and equations as tags, formatting as numbered tags', () => {
        expect(
          unit('Patients seen: <g1>1,200</g1> this year, page <g2>1</g2>'),
        ).toBeDefined();
        expect(unit('Area is <g1>πr²</g1>')).toBeDefined();
      });

      it('takes a size set only on the master through the inheritance chain', () => {
        // The title placeholder has no size on the slide or the layout; the
        // master's title style says 40 pt. The body comes from bodyStyle.
        expect(unit('Annual report').size).toBe(40);
        expect(unit('The clinic opened in March.').size).toBe(32);
        expect(unit('JUST FITS').size).toBe(24);
      });

      it('links fallback and cached-drawing copies to their unit', () => {
        expect(unit('Shown by new readers').deck.copies).toHaveLength(1);
        expect(unit('Plan the visit').deck.copies).toHaveLength(1);
      });

      it('gives the same ids on every run and leaves notes out when asked', () => {
        const again = extract().extraction!;
        expect(again.units.map((u) => u.id)).toEqual(
          extraction.units.map((u) => u.id),
        );
        const noNotes = extract({ notes: false }).extraction!;
        expect(noNotes.units.some((u) => u.deck.notes)).toBe(false);
        expect(noNotes.units.length).toBe(extraction.units.length - 1);
      });

      it('places group content through the groups’ scaled coordinates', () => {
        // Both groups halve their child extent: child coordinates count double.
        const grouped = unit('Text inside two groups');
        expect(grouped.bbox[0]).toBeGreaterThan(0);
        expect(grouped.bbox[2]).toBeLessThanOrEqual(720);
      });
    });

    describe('rebuild', () => {
      it('writes translations everywhere their text is shown', () => {
        const translations = Object.fromEntries(
          extraction.units.map((u) => [u.id, `FR ${u.text}`]),
        );
        translations[
          unit('Patients seen: <g1>1,200</g1> this year, page <g2>1</g2>').id
        ] = 'Patients vus : <g1>1 200</g1> cette année, page <g2>1</g2>';
        translations[unit('Area is <g1>πr²</g1>').id] =
          'La surface est <g1>πr²</g1>';
        const { deck, report } = rebuild(unitsFile, translations, {
          language: 'fr-FR',
        });
        expect(report.kept).toEqual([]);
        const slide1 = xml(deck, 'ppt/slides/slide1.xml');
        expect(texts(slide1)).toContain('FR Annual report');
        // The field is put back once, unchanged.
        expect(slide1.match(/type="slidenum"/g)).toHaveLength(1);
        expect(slide1).toContain('lang="fr-FR"');
        expect(texts(xml(deck, 'ppt/notesSlides/notesSlide1.xml'))).toContain(
          'FR Remember to thank the volunteers.',
        );
        expect(texts(xml(deck, 'ppt/slideMasters/slideMaster1.xml'))).toContain(
          'FR Confidential',
        );
        // Both copies of alternate content, and the equation kept as it was.
        const slide6 = xml(deck, 'ppt/slides/slide6.xml');
        expect(
          texts(slide6).filter((t) => t === 'FR Shown by new readers'),
        ).toHaveLength(2);
        expect(slide6).toContain('oMath');
        // SmartArt: its data and its cached drawing.
        expect(texts(xml(deck, 'ppt/diagrams/data1.xml'))).toContain(
          'FR Plan the visit',
        );
        expect(texts(xml(deck, 'ppt/diagrams/drawing1.xml'))).toContain(
          'FR Plan the visit',
        );
        // The chart's cached strings and its embedded workbook.
        const chart = xml(deck, 'ppt/charts/chart1.xml');
        expect(chart).toContain('<c:v>FR North</c:v>');
        const workbookName = Object.keys(parts(deck)).find((n) =>
          n.includes('embeddings/'),
        )!;
        const workbook = unzipSync(parts(deck)[workbookName]);
        expect(strFromU8(workbook['xl/sharedStrings.xml'])).toContain(
          'FR North',
        );
      });

      it('round trip: the source text as the translation leaves every part byte for byte', () => {
        const same = Object.fromEntries(
          extraction.units.map((u) => [u.id, u.text]),
        );
        const { deck, report } = rebuild(unitsFile, same);
        expect(report.written).toEqual([]);
        const before = parts(NATIVE);
        const after = parts(deck);
        expect(Object.keys(after)).toEqual(Object.keys(before));
        for (const name of Object.keys(before)) {
          expect(
            Buffer.from(after[name]).equals(Buffer.from(before[name])),
            name,
          ).toBe(true);
        }
      });

      it('changes only the parts a translation is in, which read the same elsewhere', () => {
        const one = unit('Medicine');
        const { deck, report } = rebuild(unitsFile, {
          [one.id]: 'Médicaments',
        });
        expect(report.written).toEqual(['ppt/slides/slide3.xml']);
        const before = parts(NATIVE);
        const after = parts(deck);
        for (const name of Object.keys(before)) {
          if (name === 'ppt/slides/slide3.xml') continue;
          expect(
            Buffer.from(after[name]).equals(Buffer.from(before[name])),
            name,
          ).toBe(true);
        }
        const original = texts(strFromU8(before['ppt/slides/slide3.xml']));
        const written = texts(strFromU8(after['ppt/slides/slide3.xml']));
        expect(written).toEqual(
          original.map((t) => (t === 'Medicine' ? 'Médicaments' : t)),
        );
      });

      it('keeps the namespace declarations of written parts', () => {
        const name = 'ppt/slides/slide6.xml';
        const { deck } = rebuild(unitsFile, {
          [unit('Shown by new readers').id]: 'Montré',
        });
        const declarations = (doc: string) =>
          [
            ...doc
              .slice(0, doc.indexOf('>', doc.indexOf('<p:sld')))
              .matchAll(/xmlns:(\w+)=/g),
          ]
            .map((m) => m[1])
            .sort();
        expect(declarations(xml(deck, name))).toEqual(
          declarations(strFromU8(parts(NATIVE)[name])),
        );
        expect(xml(deck, name)).toContain('xmlns:mc=');
      });

      it('sets right-to-left paragraphs and tables and a script font, without moving shapes', () => {
        const cell = unit('Medicine');
        const title = unit('Budget table');
        const { deck } = rebuild(
          unitsFile,
          { [cell.id]: 'أدوية', [title.id]: 'جدول الميزانية' },
          {
            language: 'ar-SA',
          },
        );
        const slide = xml(deck, 'ppt/slides/slide3.xml');
        expect(slide).toMatch(/<a:pPr[^>]*rtl="1"/);
        expect(slide).toMatch(/<a:tblPr[^>]*rtl="1"/);
        expect(slide).toContain('<a:cs typeface="Arial"/>');
        const offsets = (doc: string) =>
          [...doc.matchAll(/<a:off [^>]*>/g)].map((m) => m[0]);
        expect(offsets(slide)).toEqual(
          offsets(strFromU8(parts(NATIVE)['ppt/slides/slide3.xml'])),
        );
      });

      it('leaves a part it cannot write as it was, listing its units as kept', () => {
        // A units file that no longer matches slide 1 (a paragraph that is not
        // there): writing that part fails part-way.
        const stale = JSON.parse(strFromU8(unitsFile)) as Extraction;
        const title = stale.units.find((u) => u.text === 'Annual report')!;
        const body = stale.units.find(
          (u) => u.text === 'The clinic opened in March.',
        )!;
        title.deck.path = [999, 0];
        const staleFile = new TextEncoder().encode(JSON.stringify(stale));
        const other = unit('Text inside two groups');
        const { deck, report } = rebuild(staleFile, {
          [title.id]: 'Rapport annuel',
          [body.id]: 'La clinique a ouvert en mars.',
          [other.id]: 'Texte dans deux groupes',
        });
        // Every unit of slide 1 is kept, the slide's part byte for byte...
        expect(report.kept.map((k) => k.id).sort()).toEqual(
          [title.id, body.id].sort(),
        );
        expect(report.units.find((u) => u.id === body.id)?.kept).toBe(true);
        expect(
          Buffer.from(parts(deck)['ppt/slides/slide1.xml']).equals(
            Buffer.from(parts(NATIVE)['ppt/slides/slide1.xml']),
          ),
        ).toBe(true);
        // ...and the other slides are still written.
        expect(texts(xml(deck, 'ppt/slides/slide2.xml'))).toContain(
          'Texte dans deux groupes',
        );
      });

      it('never changes automatic numbering or a link target', () => {
        const link = unit('Read the <g1>full report</g1>');
        const step = unit('First step');
        const { deck } = rebuild(unitsFile, {
          [link.id]: 'Lire le <g1>rapport complet</g1>',
          [step.id]: 'Première étape',
        });
        const before = strFromU8(parts(NATIVE)['ppt/slides/slide9.xml']);
        const after = xml(deck, 'ppt/slides/slide9.xml');
        const numbering = (doc: string) => doc.match(/<a:buAutoNum [^>]*\/>/g);
        const links = (doc: string) => doc.match(/<a:hlinkClick [^>]*\/>/g);
        expect(numbering(after)).toEqual(numbering(before));
        expect(links(after)).toEqual(links(before));
        expect(texts(after)).toContain('rapport complet');
        // The link stays on the linked words only.
        expect(after).toMatch(
          /<a:hlinkClick [^>]*\/><\/a:rPr><a:t>rapport complet<\/a:t>/,
        );
      });

      it('moves a whole shape for a moved paragraph', () => {
        const moved = unit('JUST FITS');
        const { deck } = rebuild(
          unitsFile,
          {},
          { styles: { [moved.id]: { dx: 10, dy: 0 } } },
        );
        const offsets = (doc: string) =>
          [...doc.matchAll(/<a:off x="(\d+)"/g)].map((m) => Number(m[1]));
        const before = offsets(
          strFromU8(parts(NATIVE)['ppt/slides/slide8.xml']),
        );
        const after = offsets(xml(deck, 'ppt/slides/slide8.xml'));
        expect(after[0] - before[0]).toBe(10 * 12700);
        expect(after[1]).toBe(before[1]);
      });

      it('sets the typeface of every run of a refonted paragraph, and only that one', () => {
        const refonted = unit('JUST FITS');
        const { deck } = rebuild(
          unitsFile,
          {},
          { styles: { [refonted.id]: { font: 'Source Sans Pro' } } },
        );
        const after = xml(deck, 'ppt/slides/slide8.xml');
        const latin = [
          ...after.matchAll(/<a:latin typeface="Source Sans Pro"\/>/g),
        ];
        expect(latin.length).toBeGreaterThan(0);
        // A name that could break the XML is refused, the deck unchanged.
        const { deck: unsafe } = rebuild(
          unitsFile,
          {},
          { styles: { [refonted.id]: { font: 'Bad"Font' } } },
        );
        expect(xml(unsafe, 'ppt/slides/slide8.xml')).not.toContain('Bad');
      });
    });

    describe('fit', () => {
      // The fit boxes on slide 8 hold one 24 pt line, 201.6 pt wide (3 in less
      // the default insets). The texts are built against the script's own
      // measure, so each pair sits either side of a boundary.
      let boundary: {
        fits: string;
        over: string;
        atMin: string;
        pastMin: string;
      };
      beforeAll(() => {
        boundary = withDeckModule(`
w = deck.widths()
def longest(limit):
    text = ''
    while w.text(text + 'n', 24, 'Arial') <= limit:
        text += 'n'
    return text
fits = longest(201.6)
# At the smallest scale the box holds two lines at 0.7 x 24 pt.
small = longest(201.6 / 0.7 * 0.999)
print(json.dumps({'fits': fits, 'over': fits + 'n', 'atMin': small, 'pastMin': small + 'n n n n n n n n n n n n n'}))
`);
      });

      const fitOf = (text: string) => {
        const target = unit('JUST FITS');
        const { report, deck } = rebuild(unitsFile, { [target.id]: text });
        return {
          fit: report.units.find((u) => u.id === target.id)!,
          slide: xml(deck, 'ppt/slides/slide8.xml'),
        };
      };

      it('a text that just fits keeps its size', () => {
        const { fit } = fitOf(boundary.fits);
        expect(fit).toMatchObject({ scale: 1, fits: true });
      });

      it('one character more is shrunk, and still fits', () => {
        const { fit } = fitOf(boundary.over);
        expect(fit.fits).toBe(true);
        expect(fit.scale).toBeLessThan(1);
        expect(fit.scale).toBeGreaterThanOrEqual(0.7 - 1e-9);
      });

      it('a text that fits only at the smallest size is set at it', () => {
        const { fit } = fitOf(boundary.atMin);
        expect(fit.fits).toBe(true);
        expect(fit.scale).toBeGreaterThanOrEqual(0.7 - 1e-9);
      });

      it('past the smallest size it gets shrink-on-overflow and is flagged', () => {
        const { fit, slide } = fitOf(boundary.pastMin);
        expect(fit).toMatchObject({ fits: false });
        expect(fit.scale).toBeCloseTo(0.7, 5);
        expect(slide).toContain('<a:normAutofit/>');
      });
    });

    describe('refusals', () => {
      it('refuses a password-protected deck (a compound file)', () => {
        const cfb = Buffer.concat([
          Buffer.from('d0cf11e0a1b11ae1', 'hex'),
          Buffer.alloc(512),
        ]);
        expect(extract({}, cfb).refused).toMatchObject({ code: 'ENCRYPTED' });
      });

      it('refuses a damaged package', () => {
        expect(extract({}, NATIVE.subarray(0, 4000)).refused).toMatchObject({
          code: 'DAMAGED',
        });
      });

      it('refuses a part that declares a document type', () => {
        const entries = parts(NATIVE);
        entries['ppt/presentation.xml'] = Buffer.from(
          strFromU8(entries['ppt/presentation.xml']).replace(
            '?>',
            '?><!DOCTYPE p [<!ENTITY x "boom">]>',
          ),
        );
        expect(extract({}, zipSync(entries)).refused).toMatchObject({
          code: 'DOCTYPE',
        });
      });

      it('refuses a part that expands suspiciously far', () => {
        const entries = parts(NATIVE);
        entries['ppt/media/bomb.bin'] = new Uint8Array(8 * 1024 * 1024);
        expect(
          extract({}, zipSync(entries, { level: 9 })).refused,
        ).toMatchObject({
          code: 'ZIP_BOMB',
        });
      });
    });
  },
);
