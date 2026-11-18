const USER_NAMESPACE_SEGMENTS = ['uploads/files', 'uploads/images'];

/**
 * True when the blob URL lives under the authenticated user's namespace.
 *
 * Accepts both absolute Azure URLs (where the path is
 * `<container>/<userId>/uploads/...`) and relative API references
 * (`/api/file/<hash>.<ext>`). For the latter only the hash is known, and
 * callers resolve it under the authenticated user's prefix, so the
 * ownership check is implicit.
 *
 * @param url - Blob reference supplied by the client.
 * @param userId - The authenticated user's id.
 */
export function isBlobUrlOwnedByUser(url: string, userId: string): boolean {
  if (url.startsWith('/api/file/')) {
    // Hash-only reference; the storage path is rebuilt from the
    // authenticated userId, so cross-user access isn't possible.
    return true;
  }
  // Absolute blob URLs must contain the user's namespace segment. We don't
  // trust `startsWith` since the userId can appear anywhere — require
  // `/<userId>/uploads/(files|images)` to appear as a path segment.
  return USER_NAMESPACE_SEGMENTS.some((seg) =>
    url.includes(`/${userId}/${seg}/`),
  );
}
