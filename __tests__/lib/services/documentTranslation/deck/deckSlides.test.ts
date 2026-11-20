import {
  omitDeckSlides,
  withoutSlides,
} from '@/lib/services/documentTranslation/deck/deckSlides';
import { DeckFormatError } from '@/lib/services/documentTranslation/deck/deckText';
import { readDeckSlides } from '@/lib/services/documentTranslation/deck/deckText';
import { deckPdfExport } from '@/lib/services/documentTranslation/native/formats/deckFormat';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({ env: {} }));

/** Leaving slides out of a deck, and the PDF export that numbers them. */

const PRESENTATION = `<p:presentation xmlns:p="p" xmlns:r="r" xmlns:p14="p14">
<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst>
<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId2"/><p:sld r:id="rId3"/></p:sldLst></p:custShow></p:custShowLst>
<p:extLst><p:ext><p14:sectionLst><p14:section name="A"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/><p14:sldId id="258"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst>
</p:presentation>`;

describe('withoutSlides', () => {
  it('removes a slide from the list, custom shows and sections', () => {
    const { xml, remaining } = withoutSlides(PRESENTATION, new Set([2]));
    expect(remaining).toBe(2);
    expect(xml).not.toContain('r:id="rId3"');
    expect(xml).not.toContain('<p14:sldId id="257"/>');
    expect(xml).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(xml).toContain('<p14:sldId id="258"/>');
  });

  it('ignores numbers past the last slide', () => {
    expect(withoutSlides(PRESENTATION, new Set([9])).remaining).toBe(3);
  });

  it('refuses to leave no slide', () => {
    expect(() => withoutSlides(PRESENTATION, new Set([1, 2, 3]))).toThrow(
      DeckFormatError,
    );
  });
});

describe('omitDeckSlides', () => {
  it('writes a deck the slide reader sees without those slides', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omit-slides-'));
    const out = path.join(dir, 'out.pptx');
    const source = path.join(
      __dirname,
      '../../../../fixtures/pptx/hidden.pptx',
    );
    expect(await omitDeckSlides(source, out, [2, 3])).toBe(3);
    const titles = (await readDeckSlides(out)).map((slide) => slide.text);
    expect(titles).toEqual(['Slide 1', 'Slide 4', 'Slide 5']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('deckPdfExport', () => {
  it('always exports hidden slides, so PDF page n is slide n', () => {
    const options = JSON.parse(deckPdfExport().split('impress_pdf_Export:')[1]);
    expect(options).toEqual({
      ExportHiddenSlides: { type: 'boolean', value: 'true' },
    });
  });

  it('names a range of slides in ascending order, once each', () => {
    const options = JSON.parse(
      deckPdfExport([8, 2, 2, 5]).split('impress_pdf_Export:')[1],
    );
    expect(options.PageRange).toEqual({ type: 'string', value: '2,5,8' });
  });
});
