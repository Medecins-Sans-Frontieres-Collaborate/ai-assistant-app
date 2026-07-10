/**
 * Safety helpers for building Azure blob paths from user-controlled input.
 *
 * Blob paths are interpolated into container-scoped operations (and, for
 * document translation, into SAS URLs handed to Azure's Translator service
 * that carry container-wide read/write). A crafted filename extension or a
 * stray separator must never be able to redirect a path outside its intended
 * `{userId}/…/{id}.{ext}` slot or smuggle path segments.
 */

/**
 * Sanitizes a file extension pulled from a user-supplied filename or query
 * param before it is interpolated into a blob path.
 *
 * - Strips everything but `[a-z0-9]` (lowercased) — so `.`, `/`, `\`, `?`,
 *   `%2e`, query strings, and `..` sequences cannot survive.
 * - Caps length (real extensions are short; a long tail is either junk or an
 *   attempt to bloat the path).
 * - Falls back to `fallback` when the result is empty.
 *
 * @example sanitizeBlobExtension('../../secret')   // → fallback
 * @example sanitizeBlobExtension('PDF')            // → 'pdf'
 * @example sanitizeBlobExtension('pdf?sig=x')      // → 'pdf'
 */
export function sanitizeBlobExtension(
  ext: string | null | undefined,
  fallback = 'bin',
): string {
  if (!ext) return fallback;
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) return fallback;
  return cleaned.slice(0, 12);
}

/** Strict UUID v4-shape matcher for path-segment ids. */
export const BLOB_PATH_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is safe to use as a single blob-path segment: a UUID.
 * IDs that shape blob paths (jobId, uploadId) must pass this before use.
 */
export function isSafeBlobPathId(id: string | null | undefined): boolean {
  return typeof id === 'string' && BLOB_PATH_ID_REGEX.test(id);
}
