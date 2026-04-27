/**
 * Image content validation via magic-byte sniffing. The audio/video signature
 * validator (`validateBufferSignature` in `./fileValidation.ts`) doesn't cover
 * image formats, so this module fills that gap for both the upload route and
 * the chunked Server Action.
 *
 * Without this check, the server would accept arbitrary binary content under
 * an image filename + `filetype=image` and store it without any validation.
 *
 * Supports the formats listed in `IMAGE_EXTENSIONS` (lib/constants/fileLimits):
 * PNG, JPEG, GIF, WebP, BMP, ICO, SVG.
 */

export interface ImageSignatureResult {
  isValid: boolean;
  /** Set when isValid is false; safe to surface to clients. */
  error?: string;
}

type SignatureCheck = (buffer: Buffer) => boolean;

function isPng(b: Buffer): boolean {
  // 89 50 4E 47 0D 0A 1A 0A
  return (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  );
}

function isJpeg(b: Buffer): boolean {
  // FF D8 FF
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isGif(b: Buffer): boolean {
  // GIF87a / GIF89a
  return (
    b.length >= 4 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38
  );
}

function isWebp(b: Buffer): boolean {
  // RIFF....WEBP
  return (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  );
}

function isBmp(b: Buffer): boolean {
  // 42 4D
  return b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d;
}

function isIco(b: Buffer): boolean {
  // 00 00 01 00 (icon) / 00 00 02 00 (cursor)
  return (
    b.length >= 4 &&
    b[0] === 0x00 &&
    b[1] === 0x00 &&
    (b[2] === 0x01 || b[2] === 0x02) &&
    b[3] === 0x00
  );
}

function isSvg(b: Buffer): boolean {
  // SVG is text/XML — skip an optional UTF-8 BOM and leading whitespace,
  // then look for `<?xml` or `<svg` (case-insensitive on the tag name).
  // Real-world SVGs sometimes have a BOM or leading whitespace before the
  // XML prolog, so simple byte-prefix matching isn't enough.
  if (b.length < 5) return false;
  let offset = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) offset = 3;
  while (
    offset < b.length &&
    (b[offset] === 0x20 ||
      b[offset] === 0x09 ||
      b[offset] === 0x0a ||
      b[offset] === 0x0d)
  ) {
    offset++;
  }
  if (b.length - offset < 5) return false;
  const head = b
    .slice(offset, offset + 5)
    .toString('ascii')
    .toLowerCase();
  return head === '<?xml' || head.startsWith('<svg');
}

const IMAGE_SIGNATURES: SignatureCheck[] = [
  isPng,
  isJpeg,
  isGif,
  isWebp,
  isBmp,
  isIco,
  isSvg,
];

/**
 * Returns `{ isValid: true }` when the buffer's leading bytes match a known
 * image format, `{ isValid: false, error }` otherwise. Mirrors the shape of
 * `validateBufferSignature` so both checks can be wired into the upload
 * pipeline uniformly.
 */
export function validateImageSignature(buffer: Buffer): ImageSignatureResult {
  if (IMAGE_SIGNATURES.some((check) => check(buffer))) {
    return { isValid: true };
  }
  return {
    isValid: false,
    error: 'File content does not match a recognized image format',
  };
}
