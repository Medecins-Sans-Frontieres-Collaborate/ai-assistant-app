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
 * Checks if a MIME type supports comment extraction.
 *
 * @param mimeType - The MIME type to check
 * @returns True if comment extraction is supported for this type
 */
export function supportsCommentExtraction(mimeType: string): boolean {
  return (
    mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.DOCX) ||
    mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.XLSX) ||
    mimeType.startsWith(SUPPORTED_COMMENT_MIME_TYPES.PPTX)
  );
}
