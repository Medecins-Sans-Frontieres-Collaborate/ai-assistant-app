/**
 * Centralized allowlist/blocklist for file uploads.
 *
 * Imported by both the client-side upload service and the server-side upload
 * validation so the two stay in sync. Extensions are stored with the leading
 * dot, lowercase. MIME types are lowercase.
 */

/**
 * Extensions that should be rejected at both upload boundaries.
 *
 * Covers:
 *  - Windows executables and scripts (.exe, .dll, .cmd, .msi, .bat, .com, .scr, .vbs, .ps1)
 *  - Unix shell scripts (.sh)
 *  - JVM / macOS bundles (.jar, .app)
 *  - Archive formats (.zip, .rar, .7z, .tar, .gz, .iso) — rejected because
 *    they bypass text extraction and can carry unchecked executables.
 */
export const DISALLOWED_EXTENSIONS = [
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.dll',
  '.msi',
  '.jar',
  '.app',
  '.com',
  '.scr',
  '.vbs',
  '.ps1',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.iso',
];

/**
 * MIME types that should be rejected at both upload boundaries.
 *
 * `application/octet-stream` is included because it's the default for
 * unrecognised binaries — browsers send it when the client has no better
 * type hint, so accepting it would effectively waive extension enforcement.
 */
export const DISALLOWED_MIME_TYPES = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-dosexec',
  'application/x-msi',
  'application/java-archive',
  'application/x-apple-diskimage',
  'application/x-sh',
  'application/x-bat',
  'application/zip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-iso9660-image',
  'application/octet-stream',
];

/**
 * Convenience: extensions without the leading dot, for code paths that
 * strip the dot via `split('.').pop()`.
 */
export const DISALLOWED_EXTENSIONS_NO_DOT = DISALLOWED_EXTENSIONS.map((ext) =>
  ext.replace(/^\./, ''),
);
