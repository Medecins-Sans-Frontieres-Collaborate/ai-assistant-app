// Buffered uploads/imports are content-hash-named (sha256); streamed M365
// imports and chunked uploads are UUID-named. Both are valid references.
const VALID_HASH_REGEX: RegExp = /^[0-9a-f]{64}$/;
const VALID_UUID_REGEX: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Matches sanitizeBlobExtension's bound (alphanumeric, up to 12 chars).
const VALID_EXTENSION_REGEX: RegExp = /^[A-Za-z0-9]{1,12}$/;

/**
 * Whether a value is a well-formed stored-file id: a sha256 hash or a UUID,
 * optionally followed by one short alphanumeric extension. Anything else —
 * path separators, extra dots, other characters — is rejected, so an id can
 * be joined onto a storage path safely.
 *
 * @param id - The route parameter to check.
 * @returns True when the id is safe to use as a blob name.
 */
export function isValidFileId(id: string | string[] | undefined): id is string {
  if (typeof id !== 'string' || id.length < 1) {
    console.error(
      `Invalid id type '${typeof id}' for object: ${JSON.stringify(id)}`,
    );
    return false;
  }
  const idParts: string[] = id.split('.');
  if (idParts.length > 2) return false;

  const [idBase, idExtension] = idParts;
  if (idExtension && !VALID_EXTENSION_REGEX.test(idExtension)) return false;

  return VALID_HASH_REGEX.test(idBase) || VALID_UUID_REGEX.test(idBase);
}
