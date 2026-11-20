import {
  clearPagePictureCache,
  documentPagePictures,
  documentPdf,
  isPresentationType,
  pdfExportFor,
} from '@/lib/services/documents/render/documentPages';
import { getRenderService } from '@/lib/services/documents/render/renderService';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A document's pages as a PDF and pictures (PAGES in documentPages.ts):
 * presentations keep hidden slides, a range comes back in ascending order
 * and is pictured by its place in the export, and pictures are made once.
 */

vi.mock('@/lib/services/documents/render/renderService', () => ({
  getRenderService: vi.fn(),
}));

const optionsOf = (convertTo: string) =>
  JSON.parse(convertTo.slice(convertTo.indexOf(':{') + 1));

describe('pdfExportFor', () => {
  it('exports a presentation with its hidden slides, so page n is slide n', () => {
    expect(pdfExportFor('pptx')).toMatch(/^pdf:impress_pdf_Export:/);
    expect(optionsOf(pdfExportFor('PPT'))).toEqual({
      ExportHiddenSlides: { type: 'boolean', value: 'true' },
    });
  });

  it('names a range in ascending order, once each', () => {
    expect(optionsOf(pdfExportFor('odp', [8, 2, 2, 5])).PageRange).toEqual({
      type: 'string',
      value: '2,5,8',
    });
  });

  it('exports a text document with the Writer filter and no slide option', () => {
    const docx = pdfExportFor('docx', [3]);
    expect(docx).toMatch(/^pdf:writer_pdf_Export:/);
    expect(optionsOf(docx)).toEqual({
      PageRange: { type: 'string', value: '3' },
    });
  });

  it('knows which types are presentations', () => {
    expect(
      ['pptx', 'pptm', 'ppsx', 'potx', 'ppt', 'pps', 'pot', 'odp'].every(
        isPresentationType,
      ),
    ).toBe(true);
    expect(['docx', 'doc', 'odt', 'rtf', 'pdf'].some(isPresentationType)).toBe(
      false,
    );
  });
});

describe('documentPdf and documentPagePictures', () => {
  let dir: string;
  const convert = vi.fn();
  const rasterize = vi.fn();

  beforeEach(() => {
    clearPagePictureCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pages-'));
    convert.mockReset();
    rasterize.mockReset();
    vi.mocked(getRenderService).mockReturnValue({
      convert,
      rasterize,
      snapshot: vi.fn(),
    } as never);
    convert.mockImplementation(async (request: { outputDir: string }) => {
      fs.mkdirSync(request.outputDir, { recursive: true });
      const out = path.join(request.outputDir, 'out.pdf');
      fs.writeFileSync(out, '%PDF');
      return out;
    });
    // Each PDF page's picture holds its PDF page number.
    rasterize.mockImplementation(
      async (request: { pages: number[]; outputDir: string }) => {
        fs.mkdirSync(request.outputDir, { recursive: true });
        return new Map(
          request.pages.map((page) => {
            const file = path.join(request.outputDir, `p${page}.png`);
            fs.writeFileSync(file, `pdf-page-${page}`);
            return [page, file];
          }),
        );
      },
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };
  const job = { lane: 'interactive' as const };

  it('passes a PDF through without converting it', async () => {
    const pdf = write('a.pdf', '%PDF-1');
    expect(await documentPdf(pdf, 'pdf', { ...job, workDir: dir })).toBe(pdf);
    expect(convert).not.toHaveBeenCalled();
  });

  it('pictures a range by its place in the export, named by document page', async () => {
    const deck = write('deck.pptx', 'deck-1');
    const pictures = await documentPagePictures({
      inputPath: deck,
      type: 'pptx',
      pages: [7, 2],
      dpi: 100,
      workDir: dir,
      ...job,
    });
    expect(optionsOf(convert.mock.calls[0][0].convertTo).PageRange.value).toBe(
      '2,7',
    );
    expect(rasterize.mock.calls[0][0].pages).toEqual([1, 2]);
    expect(Buffer.from(pictures.get(2)!).toString()).toBe('pdf-page-1');
    expect(Buffer.from(pictures.get(7)!).toString()).toBe('pdf-page-2');
  });

  it('pictures a PDF by its own page numbers', async () => {
    const pdf = write('b.pdf', '%PDF-2');
    const pictures = await documentPagePictures({
      inputPath: pdf,
      type: 'pdf',
      pages: [4],
      dpi: 100,
      workDir: dir,
      ...job,
    });
    expect(convert).not.toHaveBeenCalled();
    expect(Buffer.from(pictures.get(4)!).toString()).toBe('pdf-page-4');
  });

  it('makes each picture once per content, page and resolution', async () => {
    const deck = write('deck.pptx', 'deck-2');
    const request = {
      inputPath: deck,
      type: 'pptx' as const,
      dpi: 100,
      workDir: dir,
      ...job,
    };
    await documentPagePictures({ ...request, pages: [1, 2] });
    const again = await documentPagePictures({ ...request, pages: [2, 3] });
    // Only slide 3 was new.
    expect(rasterize).toHaveBeenCalledTimes(2);
    expect(optionsOf(convert.mock.calls[1][0].convertTo).PageRange.value).toBe(
      '3',
    );
    expect([...again.keys()].sort()).toEqual([2, 3]);
    // Another resolution, or other content, is pictured anew.
    await documentPagePictures({ ...request, pages: [1], dpi: 144 });
    fs.writeFileSync(deck, 'deck-2-changed');
    await documentPagePictures({ ...request, pages: [1] });
    expect(rasterize).toHaveBeenCalledTimes(4);
  });
});
