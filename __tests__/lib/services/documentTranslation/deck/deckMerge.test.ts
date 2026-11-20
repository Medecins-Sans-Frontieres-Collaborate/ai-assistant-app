import {
  makeServiceCopy,
  mergeTranslatedDeck,
  takesPart,
} from '@/lib/services/documentTranslation/deck/deckMerge';
import {
  decodeXmlText,
  drawingText,
  readDeckSlides,
} from '@/lib/services/documentTranslation/deck/deckText';
import { runLibreOffice } from '@/lib/services/presentationRender/libreOfficeProcess';
import {
  readPackageDirectory,
  readPackagePart,
  writePackage,
} from '@/lib/services/presentationRender/ooxmlPackage';

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Decks through the document translation service: reading their slides,
 * and putting a translation back into the person's own package. The
 * translation is the service's real French output of rich.pptx
 * (fixtures/pptx/make_fixtures.py describes each fixture).
 */

const FIXTURES = path.join(__dirname, '../../../../fixtures/pptx');
const fixture = (name: string) => path.join(FIXTURES, name);
let dir: string;
const at = (name: string) => path.join(dir, name);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-merge-test-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const part = async (file: string, name: string) => {
  const entries = await readPackageDirectory(file);
  return (
    await readPackagePart(file, entries, name, 64 * 1024 * 1024)
  )?.toString('utf8');
};

describe('reading slides', () => {
  it('reads each slide in order, with its notes and whether it is hidden', async () => {
    const slides = await readDeckSlides(fixture('rich.pptx'));
    expect(slides.map((slide) => [slide.number, slide.hidden])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, false],
    ]);
    expect(slides[0].text).toBe('Annual report\nThe clinic opened in March.');
    expect(slides[0].notes).toBe('Remember to thank the volunteers.');
    expect(slides[1].text).toBe(
      'Budget table\nMedicine\nTransport\nTraining\nHousing',
    );
    expect(slides[4].text).toBe('Grouped shapes\nText inside a group');
    expect(slides[1].notes).toBe('');
  });

  it('numbers slides by the presentation, not by part names', async () => {
    // Swap the first two slides in the presentation's list.
    const file = fixture('hidden.pptx');
    const entries = await readPackageDirectory(file);
    const xml = (await readPackagePart(
      file,
      entries,
      'ppt/presentation.xml',
      1e6,
    ))!.toString();
    const ids = [...xml.matchAll(/<p:sldId\b[^>]*\/>/g)].map((m) => m[0]);
    const swapped = xml.replace(ids[0] + ids[1], ids[1] + ids[0]);
    expect(swapped).not.toBe(xml);
    await writePackage(
      file,
      at('reordered.pptx'),
      new Map([['ppt/presentation.xml', Buffer.from(swapped)]]),
    );
    const slides = await readDeckSlides(at('reordered.pptx'));
    expect(slides.map((slide) => slide.text)).toEqual([
      'Slide 2',
      'Slide 1',
      'Slide 3',
      'Slide 4',
      'Slide 5',
    ]);
    expect(slides[0].part).toBe('ppt/slides/slide2.xml');
    expect(slides[2].hidden).toBe(true);
  });

  it('reads text as written: entities, breaks, one copy of alternate content', () => {
    expect(decodeXmlText('A &amp; B &lt;3 &#233;&#x20AC; &bogus;')).toBe(
      'A & B <3 é€ &bogus;',
    );
    const xml =
      '<a:p><a:r><a:t>Line one</a:t></a:r><a:br/><a:r><a:t xml:space="preserve">line two</a:t></a:r></a:p>' +
      '<a:p></a:p>' +
      '<mc:AlternateContent><mc:Choice><a:p><a:r><a:t>Shown</a:t></a:r></a:p></mc:Choice>' +
      '<mc:Fallback><a:p><a:r><a:t>Shown</a:t></a:r></a:p></mc:Fallback></mc:AlternateContent>';
    expect(drawingText(xml)).toBe('Line one\nline two\nShown');
  });
});

describe('the copy sent to the service', () => {
  it('is the deck itself for a .pptx', async () => {
    await makeServiceCopy(fixture('rich.pptx'), 'pptx', at('service.pptx'));
    expect(fs.readFileSync(at('service.pptx'))).toEqual(
      fs.readFileSync(fixture('rich.pptx')),
    );
  });

  it('is a plain presentation without macros for a .pptm', async () => {
    await makeServiceCopy(fixture('rich.pptm'), 'pptm', at('service-m.pptx'));
    const names = (await readPackageDirectory(at('service-m.pptx'))).map(
      (e) => e.name,
    );
    expect(names).not.toContain('ppt/vbaProject.bin');
    expect(await part(at('service-m.pptx'), '[Content_Types].xml')).toContain(
      'presentationml.presentation.main+xml',
    );
    expect(
      await part(at('service-m.pptx'), 'ppt/_rels/presentation.xml.rels'),
    ).not.toContain('vbaProject');
    // Still the same slides.
    expect((await readDeckSlides(at('service-m.pptx'))).length).toBe(5);
  });
});

describe('merging a translation into the person’s deck', () => {
  it('takes slides, charts and notes; keeps structure and media', async () => {
    const result = await mergeTranslatedDeck({
      basePath: fixture('rich.pptx'),
      translatedPath: fixture('rich.fr.pptx'),
      outPath: at('merged.pptx'),
      translateNotes: true,
    });
    const slides = await readDeckSlides(at('merged.pptx'));
    expect(slides[0].text).toBe(
      'Rapport annuel\nLa clinique a ouvert en mars.',
    );
    expect(slides[0].notes).toBe("N'oubliez pas de remercier les bénévoles.");
    expect(slides[3].hidden).toBe(true);
    expect(result.taken).toContain('ppt/charts/chart1.xml');
    expect(result.taken.some((name) => name.includes('_rels'))).toBe(false);
    expect(await part(at('merged.pptx'), '[Content_Types].xml')).toBe(
      await part(fixture('rich.pptx'), '[Content_Types].xml'),
    );
  });

  it('keeps the original notes when they are not to be translated', async () => {
    const result = await mergeTranslatedDeck({
      basePath: fixture('rich.pptx'),
      translatedPath: fixture('rich.fr.pptx'),
      outPath: at('merged-no-notes.pptx'),
      translateNotes: false,
    });
    const slides = await readDeckSlides(at('merged-no-notes.pptx'));
    expect(slides[0].text).toBe(
      'Rapport annuel\nLa clinique a ouvert en mars.',
    );
    expect(slides[0].notes).toBe('Remember to thank the volunteers.');
    expect(
      result.taken.some((name) => name.startsWith('ppt/notesSlides/')),
    ).toBe(false);
  });

  it('keeps a .pptm’s macros and type byte for byte', async () => {
    await mergeTranslatedDeck({
      basePath: fixture('rich.pptm'),
      translatedPath: fixture('rich.fr.pptx'),
      outPath: at('merged.pptm'),
      translateNotes: true,
    });
    for (const name of [
      'ppt/vbaProject.bin',
      '[Content_Types].xml',
      'ppt/_rels/presentation.xml.rels',
    ]) {
      expect(await part(at('merged.pptm'), name)).toBe(
        await part(fixture('rich.pptm'), name),
      );
    }
    expect((await readDeckSlides(at('merged.pptm')))[0].text).toContain(
      'Rapport annuel',
    );
  });

  it('takes only what a translation may change', () => {
    expect(takesPart('ppt/slides/slide1.xml', true)).toBe(true);
    expect(takesPart('ppt/notesSlides/notesSlide1.xml', true)).toBe(true);
    expect(takesPart('ppt/notesSlides/notesSlide1.xml', false)).toBe(false);
    for (const name of [
      '[Content_Types].xml',
      'docProps/core.xml',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/media/image1.png',
      'ppt/vbaProject.bin',
    ]) {
      expect(takesPart(name, true)).toBe(false);
    }
  });
});

const hasLibreOffice = (() => {
  try {
    execFileSync('libreoffice', ['--version'], { timeout: 30_000 });
    execFileSync('pdftotext', ['-v'], { timeout: 30_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasLibreOffice)('a merged deck in LibreOffice', () => {
  it('opens and shows the translation, macros kept', async () => {
    await mergeTranslatedDeck({
      basePath: fixture('rich.pptm'),
      translatedPath: fixture('rich.fr.pptx'),
      outPath: at('open-me.pptm'),
      translateNotes: true,
    });
    const pdf = await runLibreOffice({
      inputPath: at('open-me.pptm'),
      importFilter: 'Impress MS PowerPoint 2007 XML',
      convertTo: 'pdf',
      outputDir: at('pdf'),
      profileDir: at('lo-profile'),
      timeoutMs: 120_000,
      memoryLimitMb: 2048,
    });
    const text = execFileSync('pdftotext', [pdf, '-']).toString();
    expect(text).toContain('Rapport annuel');
    expect(text).toContain('Tableau budgétaire');
  }, 130_000);
});
