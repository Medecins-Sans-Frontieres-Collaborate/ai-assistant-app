import { extractDocxComments } from './docxComments';
import { formatCommentsSection } from './formatComments';
import { extractPptxComments } from './pptxComments';
import {
  CommentExtractionResult,
  SUPPORTED_COMMENT_MIME_TYPES,
  supportsCommentExtraction,
} from './types';
import { extractXlsxComments } from './xlsxComments';

export { formatCommentsSection } from './formatComments';
export type { CommentExtractionResult, DocumentComment } from './types';
export {
  SUPPORTED_COMMENT_MIME_TYPES,
  supportsCommentExtraction,
} from './types';

/**
 * Extracts comments from an Office document (DOCX, XLSX, or PPTX).
 *
 * This is the main entry point for comment extraction. It detects the document
 * type from the MIME type and delegates to the appropriate extractor.
 *
 * Supported formats:
 * - DOCX (Word): Comments stored in word/comments.xml
 * - XLSX (Excel): Legacy comments (xl/comments*.xml) and threaded comments (xl/threadedComments*.xml)
 * - PPTX (PowerPoint): Comments in ppt/comments/ with author info in ppt/commentAuthors.xml
 *
 * Old binary formats (.doc, .xls, .ppt) are not supported as they require
 * different parsing approaches.
 *
 * @param buffer - The file content as a Buffer
 * @param mimeType - The MIME type of the file
 * @returns Promise resolving to extraction result with comments array
 *
 * @example
 * ```typescript
 * const buffer = await file.arrayBuffer();
 * const result = await extractComments(Buffer.from(buffer), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
 * if (result.comments.length > 0) {
 *   console.log(formatCommentsSection(result.comments));
 * }
 * ```
 */
export async function extractComments(
  buffer: Buffer,
  mimeType: string,
): Promise<CommentExtractionResult> {
  if (!supportsCommentExtraction(mimeType)) {
    return { comments: [] };
  }

  if (mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.DOCX)) {
    return extractDocxComments(buffer);
  }

  if (mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.XLSX)) {
    return extractXlsxComments(buffer);
  }

  if (mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.PPTX)) {
    return extractPptxComments(buffer);
  }

  return { comments: [] };
}

/**
 * Extracts comments from a document and formats them as a text section.
 *
 * Convenience function that combines extraction and formatting.
 * Returns an empty string if no comments are found.
 *
 * @param buffer - The file content as a Buffer
 * @param mimeType - The MIME type of the file
 * @returns Promise resolving to formatted comments section, or empty string
 */
export async function extractAndFormatComments(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const result = await extractComments(buffer, mimeType);

  if (result.error) {
    console.warn('[extractAndFormatComments]', result.error);
  }

  return formatCommentsSection(result.comments);
}
