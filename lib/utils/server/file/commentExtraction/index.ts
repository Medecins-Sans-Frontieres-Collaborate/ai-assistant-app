import { extractDocxComments } from './docxComments';
import { formatCommentsSection } from './formatComments';
import { extractPptxComments } from './pptxComments';
import { extractXlsxComments } from './xlsxComments';

/**
 * Represents a single comment extracted from an Office document.
 */
export interface DocumentComment {
  /** Unique identifier of the comment within the document */
  id: string;
  /** Name of the comment author */
  author: string;
  /** ISO date string when the comment was created */
  date?: string;
  /** The text content of the comment */
  text: string;
  /** Location context: cell reference for XLSX, slide number for PPTX, paragraph context for DOCX */
  location?: string;
}

/**
 * Result of attempting to extract comments from a document.
 */
export interface CommentExtractionResult {
  /** Array of extracted comments, empty if none found */
  comments: DocumentComment[];
  /** Error message if extraction failed, undefined on success */
  error?: string;
}

/**
 * MIME types for Office documents that support comment extraction.
 */
export const SUPPORTED_COMMENT_MIME_TYPES = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/**
 * File extensions for Office documents that support comment extraction.
 * Used as fallback when MIME type detection fails (e.g., application/octet-stream).
 */
export const SUPPORTED_COMMENT_EXTENSIONS = [
  '.docx',
  '.xlsx',
  '.pptx',
] as const;

/**
 * Checks if a file supports comment extraction based on MIME type or filename extension.
 *
 * This function first checks the MIME type, then falls back to extension-based detection
 * if the MIME type is generic (e.g., application/octet-stream). This ensures consistency
 * with how loadDocument handles format detection.
 *
 * @param mimeType - The MIME type to check
 * @param filename - Optional filename for extension-based fallback
 * @returns True if comment extraction is supported for this file
 */
export function supportsCommentExtraction(
  mimeType: string,
  filename?: string,
): boolean {
  // Check MIME type first
  if (
    mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.DOCX) ||
    mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.XLSX) ||
    mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.PPTX)
  ) {
    return true;
  }

  // Fall back to extension check if filename provided
  if (filename) {
    const lowerFilename = filename.toLowerCase();
    return SUPPORTED_COMMENT_EXTENSIONS.some((ext) =>
      lowerFilename.endsWith(ext),
    );
  }

  return false;
}

export { formatCommentsSection } from './formatComments';

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
