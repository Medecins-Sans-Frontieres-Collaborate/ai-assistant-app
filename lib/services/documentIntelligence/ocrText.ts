/**
 * OCR of an uploaded document into the same paged plain text the PDF
 * extractors produce, so everything downstream (the text cache, page
 * selection, chunking) reads an OCR result like any other extraction.
 */
import {
  AnalyzedPage,
  analyzeDocument,
} from '@/lib/services/documentIntelligence/client';

/**
 * Joins per-page text with the `--- Page N ---` marker lines written by
 * `extractTextWithPdfJs` (lib/utils/server/file/fileHandling.ts). Pages
 * without text are left out, as that extractor leaves them out.
 *
 * @param pages - Pages in document order.
 * @returns The paged text; '' when no page has text.
 */
export function formatPagedText(pages: readonly AnalyzedPage[]): string {
  return pages
    .filter((page) => page.text.trim() !== '')
    .map((page) => `--- Page ${page.pageNumber} ---\n${page.text.trim()}`)
    .join('\n\n');
}

/** Text read from a document by OCR. */
export interface OcrTextResult {
  /** Paged text, see {@link formatPagedText}. */
  text: string;
  /** Pages the service analysed. */
  pagesAnalyzed: number;
}

/**
 * Reads a PDF's text with OCR.
 *
 * @param pdf - The PDF's bytes.
 * @param signal - Aborts the analysis.
 * @returns The paged text and how many pages were analysed.
 * @throws DocumentIntelligenceError when the service is not configured,
 *   refuses the file, fails, times out, or the request is aborted.
 */
export async function ocrPdfToPagedText(
  pdf: Buffer,
  signal?: AbortSignal,
): Promise<OcrTextResult> {
  const result = await analyzeDocument(pdf, {
    model: 'prebuilt-read',
    contentType: 'application/pdf',
    signal,
  });
  return {
    text: formatPagedText(result.pages),
    pagesAnalyzed: result.pages.length,
  };
}
