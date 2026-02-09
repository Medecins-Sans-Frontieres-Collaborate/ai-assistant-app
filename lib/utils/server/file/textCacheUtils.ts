/**
 * Utilities for document text caching.
 * Extracted from fileUpload.ts to avoid "use server" export restrictions.
 *
 * These utilities determine which file types benefit from text caching
 * and generate the blob paths for cached text versions.
 */

/**
 * File extensions that require expensive text extraction (PDF, Office docs, EPUB).
 * These formats benefit from caching the extracted plain text.
 */
const CACHEABLE_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.pptx', '.epub'];

/**
 * Determines if a file should have its text content cached.
 * Returns true for file types that require expensive conversion (PDF, Office, EPUB).
 *
 * @param filename - The original filename with extension
 * @returns True if the file type benefits from text caching
 */
export function shouldCacheText(filename: string): boolean {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) return false;

  const ext = filename.toLowerCase().slice(lastDotIndex);
  return CACHEABLE_EXTENSIONS.includes(ext);
}

/**
 * Generates the blob path for the cached plain-text version of a file.
 *
 * @param originalBlobPath - The original blob storage path
 * @returns The path where the cached text version should be stored
 */
export function getCachedTextPath(originalBlobPath: string): string {
  return `${originalBlobPath}.cached.txt`;
}
