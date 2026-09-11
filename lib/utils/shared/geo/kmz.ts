/**
 * Reads the KML document out of a KMZ archive without trusting it.
 *
 * A KMZ is a zip; only the KML inside is wanted. Everything else — images,
 * overlays, nested archives — is never inflated, and the one entry that is
 * inflated is bounded twice: by its declared size before touching it and by
 * the bytes actually produced, so a crafted archive that lies about its size
 * cannot become a decompression bomb. Entry names are never used as paths,
 * so traversal has nowhere to go. Parsing the resulting text is the KML
 * reader's job, which uses DOMParser and therefore never resolves external
 * entities or executes anything.
 *
 * Client-safe: fflate is pure JavaScript.
 */
import { strFromU8, unzipSync } from 'fflate';

/** Hard ceiling on the inflated KML. Real-world KMLs are kilobytes; 50 MB is generous. */
export const KMZ_MAX_KML_BYTES = 50 * 1024 * 1024;
/** Ceiling on the archive itself, checked before any inflation. */
export const KMZ_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export class KmzError extends Error {
  constructor(
    message: string,
    public readonly code: 'too_large' | 'no_kml' | 'invalid',
  ) {
    super(message);
    this.name = 'KmzError';
  }
}

/**
 * Returns the KML text inside `archive`. Prefers `doc.kml` (the convention),
 * else the first `.kml` entry at any depth.
 */
export function kmlFromKmz(archive: Uint8Array): string {
  if (archive.byteLength > KMZ_MAX_ARCHIVE_BYTES) {
    throw new KmzError('KMZ archive is too large', 'too_large');
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      // Decide per entry BEFORE inflating: only .kml, and only if the
      // declared size is within bounds. Everything else is skipped unread.
      filter: (file) =>
        /\.kml$/i.test(file.name) && file.originalSize <= KMZ_MAX_KML_BYTES,
    });
  } catch {
    throw new KmzError('Not a readable KMZ archive', 'invalid');
  }
  const names = Object.keys(entries);
  if (names.length === 0)
    throw new KmzError('No KML found in archive', 'no_kml');
  const preferred =
    names.find((n) => n.toLowerCase() === 'doc.kml') ??
    names.find((n) => /(^|\/)doc\.kml$/i.test(n)) ??
    names.sort()[0];
  const bytes = entries[preferred];
  // The declared size was checked; the produced size is what actually counts.
  if (bytes.byteLength > KMZ_MAX_KML_BYTES) {
    throw new KmzError('KML inside archive is too large', 'too_large');
  }
  return strFromU8(bytes);
}
