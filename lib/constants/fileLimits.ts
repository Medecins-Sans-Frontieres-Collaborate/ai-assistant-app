/**
 * Centralized file upload limits configuration.
 * Provides category detection, limit lookup, and validation utilities.
 *
 * All file size limits and content limits are defined in lib/utils/app/const.ts.
 * This module provides utilities for applying those limits consistently.
 */
import {
  CONTENT_LIMITS,
  FILE_SIZE_LIMITS,
  FILE_SIZE_LIMITS_DISPLAY,
  formatBytes,
  formatNumber,
} from '@/lib/utils/app/const';

/**
 * File categories for limit enforcement.
 * Each category has different size limits and validation rules.
 */
export type FileCategory = 'image' | 'audio' | 'video' | 'document' | 'unknown';

// =============================================================================
// File Extension Categories
// =============================================================================

/**
 * Image file extensions.
 */
const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
];

/**
 * Audio file extensions.
 * Note: .webm can be audio or video - use MIME type to disambiguate.
 */
const AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.oga',
  '.flac',
  '.aac',
  '.opus',
  '.wma',
  '.mpeg',
  '.mpga',
];

/**
 * Video file extensions.
 * Note: .webm defaults to video if MIME type is unavailable.
 * `.m4v` and `.3gp` are video containers whose audio track is extracted.
 * `.ts` is deliberately excluded — it collides with TypeScript source files
 * (see AUDIO_VIDEO_EXTENSIONS in lib/constants/fileTypes.ts).
 */
const VIDEO_EXTENSIONS = [
  '.mp4',
  '.m4v',
  '.mkv',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
  '.webm',
  '.3gp',
  '.mpg',
];

/**
 * Document file extensions (text-based and binary documents).
 */
const DOCUMENT_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.csv',
  '.epub',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.tex',
  '.py',
  '.sql',
];

/**
 * Text-based document extensions that require content (character) validation.
 */
const TEXT_CONTENT_EXTENSIONS = [
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.csv',
  '.tex',
  '.py',
  '.sql',
  '.epub',
];

/**
 * PDF extensions (require page count validation).
 */
const PDF_EXTENSIONS = ['.pdf'];

// =============================================================================
// Category Detection
// =============================================================================

/**
 * Extracts the file extension from a filename.
 *
 * @param filename - The filename to extract extension from
 * @returns Lowercase extension with leading dot (e.g., ".pdf") or empty string
 */
function getExtension(filename: string): string {
  if (!filename) return '';
  const parts = filename.split('.');
  if (parts.length < 2) return '';
  return '.' + parts.pop()!.toLowerCase();
}

/**
 * Determines the file category from filename and optional MIME type.
 * MIME type takes precedence for ambiguous extensions like .webm.
 *
 * @param filename - The filename to categorize
 * @param mimeType - Optional MIME type for more accurate categorization
 * @returns The file category
 */
export function getFileCategory(
  filename: string,
  mimeType?: string,
): FileCategory {
  // MIME type takes precedence for accurate categorization
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
  }

  const ext = getExtension(filename);
  if (!ext) return 'unknown';

  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (DOCUMENT_EXTENSIONS.includes(ext)) return 'document';

  return 'unknown';
}

// =============================================================================
// Size Limit Lookup
// =============================================================================

/**
 * Gets the file size limit in bytes for a given category.
 *
 * @param category - The file category
 * @returns Maximum file size in bytes
 */
export function getFileSizeLimit(category: FileCategory): number {
  switch (category) {
    case 'image':
      return FILE_SIZE_LIMITS.IMAGE_MAX_BYTES;
    case 'audio':
      return FILE_SIZE_LIMITS.AUDIO_MAX_BYTES;
    case 'video':
      return FILE_SIZE_LIMITS.VIDEO_MAX_BYTES;
    case 'document':
      return FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES;
    case 'unknown':
    default:
      // Default to document limit for unknown files
      return FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES;
  }
}

/**
 * Gets a human-readable limit string for a given category.
 *
 * @param category - The file category
 * @returns Human-readable limit string (e.g., "5MB", "1GB")
 */
export function getFileSizeLimitDisplay(category: FileCategory): string {
  switch (category) {
    case 'image':
      return FILE_SIZE_LIMITS_DISPLAY.IMAGE;
    case 'audio':
      return FILE_SIZE_LIMITS_DISPLAY.AUDIO;
    case 'video':
      return FILE_SIZE_LIMITS_DISPLAY.VIDEO;
    case 'document':
      return FILE_SIZE_LIMITS_DISPLAY.DOCUMENT;
    case 'unknown':
    default:
      return FILE_SIZE_LIMITS_DISPLAY.DOCUMENT;
  }
}

// =============================================================================
// Content Validation
// =============================================================================

/**
 * Content limit information for text-based files.
 */
export interface ContentLimit {
  type: 'pages' | 'characters';
  limit: number;
  display: string;
}

/**
 * Checks if a file requires server-side content validation.
 * This applies to text-based documents where content length matters more than file size.
 *
 * @param filename - The filename to check
 * @returns True if content validation is required
 */
export function requiresContentValidation(filename: string): boolean {
  const ext = getExtension(filename);
  return PDF_EXTENSIONS.includes(ext) || TEXT_CONTENT_EXTENSIONS.includes(ext);
}

/**
 * Gets the content limit configuration for a file.
 * Returns null if the file doesn't need content validation.
 *
 * @param filename - The filename to get content limit for
 * @returns Content limit configuration or null
 */
export function getContentLimit(filename: string): ContentLimit | null {
  const ext = getExtension(filename);

  if (PDF_EXTENSIONS.includes(ext)) {
    return {
      type: 'pages',
      limit: CONTENT_LIMITS.PDF_MAX_PAGES,
      display: FILE_SIZE_LIMITS_DISPLAY.PDF_PAGES,
    };
  }

  if (TEXT_CONTENT_EXTENSIONS.includes(ext)) {
    const tokenEstimate = Math.floor(
      CONTENT_LIMITS.TEXT_MAX_CHARACTERS /
        CONTENT_LIMITS.CHARS_PER_TOKEN_ESTIMATE,
    );
    return {
      type: 'characters',
      limit: CONTENT_LIMITS.TEXT_MAX_CHARACTERS,
      display: `${FILE_SIZE_LIMITS_DISPLAY.TEXT_CHARS} (~${formatNumber(tokenEstimate)} tokens)`,
    };
  }

  return null;
}

// =============================================================================
// File Validation
// =============================================================================

/**
 * Result of file size validation.
 */
export interface FileSizeValidationResult {
  valid: boolean;
  error?: string;
  category: FileCategory;
}

/**
 * Validates a file against size limits (for client-side validation).
 * This checks file size only; content validation happens server-side.
 *
 * @param file - The File object to validate
 * @returns Validation result with category and optional error
 */
export function validateFileSize(file: File): FileSizeValidationResult {
  const category = getFileCategory(file.name, file.type);
  const maxSize = getFileSizeLimit(category);

  if (file.size > maxSize) {
    const limitDisplay = getFileSizeLimitDisplay(category);
    const categoryLabel =
      category === 'unknown' ? 'File' : capitalize(category);
    return {
      valid: false,
      error: `${categoryLabel} files must be under ${limitDisplay}`,
      category,
    };
  }

  return { valid: true, category };
}

/**
 * Validates file size given raw values (for server-side validation).
 *
 * @param filename - The filename
 * @param fileSize - The file size in bytes
 * @param mimeType - Optional MIME type
 * @returns Validation result with category and optional error
 */
export function validateFileSizeRaw(
  filename: string,
  fileSize: number,
  mimeType?: string,
): FileSizeValidationResult {
  const category = getFileCategory(filename, mimeType);
  const maxSize = getFileSizeLimit(category);

  if (fileSize > maxSize) {
    const limitDisplay = getFileSizeLimitDisplay(category);
    const categoryLabel =
      category === 'unknown' ? 'File' : capitalize(category);
    return {
      valid: false,
      error: `${categoryLabel} files must be under ${limitDisplay}`,
      category,
    };
  }

  return { valid: true, category };
}

/**
 * Content validation result.
 */
export interface ContentValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates document content length against configured limits.
 * Called after text extraction to enforce content-based limits.
 *
 * @param filename - The original filename
 * @param content - The extracted text content
 * @param pageCount - Optional page count (for PDFs)
 * @returns Validation result with optional error
 */
export function validateDocumentContent(
  filename: string,
  content: string,
  pageCount?: number,
): ContentValidationResult {
  const contentLimit = getContentLimit(filename);

  if (!contentLimit) {
    return { valid: true };
  }

  if (contentLimit.type === 'pages' && pageCount !== undefined) {
    if (pageCount > contentLimit.limit) {
      return {
        valid: false,
        error: `PDF documents are limited to ${contentLimit.display}. This file has ${pageCount} pages.`,
      };
    }
    return { valid: true };
  }

  if (contentLimit.type === 'characters') {
    if (content.length > contentLimit.limit) {
      const actualDisplay = formatNumber(content.length);
      return {
        valid: false,
        error: `Text documents are limited to ${contentLimit.display}. This file has ${actualDisplay} characters.`,
      };
    }
    return { valid: true };
  }

  return { valid: true };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Capitalizes the first letter of a string.
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Gets the maximum file size in bytes for a File object.
 * Convenience method that combines category detection and limit lookup.
 *
 * @param file - The File object
 * @returns Maximum file size in bytes and display string
 */
export function getMaxSizeForFile(file: File): {
  bytes: number;
  display: string;
} {
  const category = getFileCategory(file.name, file.type);
  return {
    bytes: getFileSizeLimit(category),
    display: getFileSizeLimitDisplay(category),
  };
}

// Re-export formatting utilities for convenience
export { formatBytes, formatNumber };
