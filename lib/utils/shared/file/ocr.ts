/**
 * Rules for offering optical character recognition (OCR) on an uploaded
 * document, shared by the OCR route and the UI that offers it.
 */

/** Limit key of the daily OCR page allowance (config/limits.ts). */
export const OCR_PAGES_LIMIT_KEY = 'feature.ocr.pagesPerDay';

/**
 * Most pages one OCR request reads. The request is synchronous, so this
 * bounds how long a user waits and how much one click can cost.
 */
export const MAX_OCR_PAGES = 500;

/** Server error codes of the OCR route. */
export const OCR_ERROR = {
  notConfigured: 'OCR_NOT_CONFIGURED',
  unsupportedFormat: 'OCR_UNSUPPORTED_FORMAT',
  tooManyPages: 'OCR_TOO_MANY_PAGES',
  noText: 'NO_EXTRACTABLE_TEXT',
  failed: 'OCR_FAILED',
} as const;

/** Whether a file can be read with OCR, judged by its name. */
export function supportsOcr(filename: string): boolean {
  return /\.pdf$/i.test(filename.trim());
}

/**
 * Below this many characters per page, on average, a document's text layer
 * is treated as sparse. A page of prose has 1,500 to 3,000 characters; a
 * scanned page whose only real text is a stamp, header or page number has
 * a few dozen.
 */
export const SPARSE_TEXT_CHARS_PER_PAGE = 120;

/**
 * Below this share of pages carrying any text, a document is treated as
 * sparse: most of it is probably images of text.
 */
export const SPARSE_TEXT_PAGE_SHARE = 0.5;

/** A single page says too little about a document to call it sparse. */
const MIN_PAGES_TO_JUDGE = 2;

/**
 * Whether extracted text is so thin that the document is probably scanned
 * in part, and worth offering OCR for.
 *
 * @param pageTextLengths - Character count of each page that has text.
 * @param pageCount - Pages in the document (pages without text included).
 * @returns True when the text is sparse by either threshold; false for a
 *   document too short to judge.
 */
export function looksLikeSparseText(
  pageTextLengths: readonly number[],
  pageCount: number,
): boolean {
  if (pageCount < MIN_PAGES_TO_JUDGE) return false;
  const total = pageTextLengths.reduce((sum, length) => sum + length, 0);
  // A tolerance keeps a document authored exactly at a threshold on the
  // "has text" side, whatever the floating-point division yields.
  const epsilon = 1e-9;
  return (
    total / pageCount < SPARSE_TEXT_CHARS_PER_PAGE - epsilon ||
    pageTextLengths.length / pageCount < SPARSE_TEXT_PAGE_SHARE - epsilon
  );
}
