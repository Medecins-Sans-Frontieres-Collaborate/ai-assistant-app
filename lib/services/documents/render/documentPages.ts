/**
 * A document's pages as a PDF and as pictures, for any type the render
 * service opens, so every feature numbers pages the same way.
 *
 * PAGES: page n of a presentation is slide n in presentation order, hidden
 * slides included (they are exported, so the numbers never shift); page n of
 * a text document is the nth page LibreOffice lays out; page n of a PDF is
 * its nth page.
 *
 * Pictures are kept in memory per file content, type, resolution and page,
 * so a feature that pictures the same document twice (reading it, then
 * checking it) renders it once.
 */
import Hasher from '@/lib/utils/app/hash';

import { LibreOfficeInputType } from './libreOfficeInputs';
import { RenderLane } from './renderQueue';
import { getRenderService } from './renderService';

import fs from 'fs';
import path from 'path';

/** A type the render service can make pages of. */
export type PagedDocumentType = LibreOfficeInputType | 'pdf';

/** Pictures kept between calls, across documents. */
export const PAGE_PICTURES_KEPT = 120;

const pictureCache = new Map<string, Uint8Array>();

/** Types Impress lays out (presentations); the rest are text documents. */
const PRESENTATION_TYPES: ReadonlySet<string> = new Set([
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'ppt',
  'pps',
  'pot',
  'odp',
]);

/** Whether a type is a presentation (its pages are slides). */
export function isPresentationType(type: string): boolean {
  return PRESENTATION_TYPES.has(type.toLowerCase());
}

/**
 * The LibreOffice `--convert-to` argument that exports `type` as a PDF.
 * Presentations keep their hidden slides (see PAGES); `pages`, when given,
 * limits the export to those pages, which then come out in ascending order.
 *
 * @param type - The document's type (extension, no dot).
 * @param pages - 1-based pages to export; all when absent or empty.
 * @example pdfExportFor('pptx', [3, 1]) // pdf:impress_pdf_Export:{...,"PageRange":{...,"value":"1,3"}}
 */
export function pdfExportFor(type: string, pages?: readonly number[]): string {
  const presentation = isPresentationType(type);
  const options: Record<string, { type: string; value: string }> = {};
  if (presentation) {
    options.ExportHiddenSlides = { type: 'boolean', value: 'true' };
  }
  if (pages?.length) {
    options.PageRange = {
      type: 'string',
      value: [...new Set(pages)].sort((a, b) => a - b).join(','),
    };
  }
  const filter = presentation ? 'impress_pdf_Export' : 'writer_pdf_Export';
  return `pdf:${filter}:${JSON.stringify(options)}`;
}

/** Where a job waits and how it is told about its place. */
export interface PageJobOptions {
  lane: RenderLane;
  /** A folder the caller owns and removes. */
  workDir: string;
  signal?: AbortSignal;
  onPosition?: (ahead: number) => void;
}

/**
 * The document as a PDF: converted, or the file itself when it is one.
 *
 * @param inputPath - The document on disk.
 * @param type - Its type (extension, no dot).
 * @param pages - Pages to export; all when absent. The PDF's page k is the
 *   kth of them in ascending order.
 * @returns The PDF's path.
 * @throws The render service's errors (signature, busy, timeout, failure).
 */
export async function documentPdf(
  inputPath: string,
  type: PagedDocumentType,
  options: PageJobOptions,
  pages?: readonly number[],
): Promise<string> {
  if (type === 'pdf') return inputPath;
  return getRenderService().convert({
    inputPath,
    type,
    convertTo: pdfExportFor(type, pages),
    outputDir: path.join(
      options.workDir,
      `pdf-${path.basename(inputPath).replace(/\W/g, '_')}-${pages?.join('_') ?? 'all'}`,
    ),
    lane: options.lane,
    signal: options.signal,
    onPosition: options.onPosition,
  });
}

function remember(key: string, png: Uint8Array): void {
  pictureCache.delete(key);
  pictureCache.set(key, png);
  while (pictureCache.size > PAGE_PICTURES_KEPT) {
    const oldest = pictureCache.keys().next().value;
    if (oldest === undefined) break;
    pictureCache.delete(oldest);
  }
}

/**
 * Pictures of some pages of a document (PNG, by page number). Pages already
 * pictured at this resolution come from memory; the rest are exported and
 * rasterized in one job each.
 *
 * @param request.pages - 1-based pages the document has.
 * @param request.dpi - Resolution (at most MAX_RASTER_DPI).
 * @throws The render service's errors (signature, busy, timeout, failure).
 */
export async function documentPagePictures(
  request: {
    inputPath: string;
    type: PagedDocumentType;
    pages: readonly number[];
    dpi: number;
  } & PageJobOptions,
): Promise<Map<number, Uint8Array>> {
  const { inputPath, type, dpi } = request;
  const hash = Hasher.sha256(await fs.promises.readFile(inputPath));
  const keyOf = (page: number) => `${hash}:${type}:${dpi}:${page}`;
  const found = new Map<number, Uint8Array>();
  const missing: number[] = [];
  for (const page of new Set(request.pages)) {
    const cached = pictureCache.get(keyOf(page));
    if (cached) found.set(page, cached);
    else missing.push(page);
  }
  if (missing.length === 0) return found;
  missing.sort((a, b) => a - b);

  // A converted range holds the missing pages in ascending order; a PDF is
  // pictured by its own page numbers.
  const pdfPath = await documentPdf(inputPath, type, request, missing);
  const pdfPageOf = (page: number) =>
    type === 'pdf' ? page : missing.indexOf(page) + 1;
  const files = await getRenderService().rasterize({
    pdfPath,
    pages: missing.map(pdfPageOf),
    dpi,
    outputDir: path.join(
      request.workDir,
      `pictures-${hash.slice(0, 12)}-${dpi}`,
    ),
    lane: request.lane,
    signal: request.signal,
    onPosition: request.onPosition,
  });
  for (const page of missing) {
    const file = files.get(pdfPageOf(page));
    if (!file) continue;
    const png = new Uint8Array(await fs.promises.readFile(file));
    remember(keyOf(page), png);
    found.set(page, png);
  }
  return found;
}

/** Forgets every kept picture (tests). */
export function clearPagePictureCache(): void {
  pictureCache.clear();
}
