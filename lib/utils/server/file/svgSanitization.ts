import { getDOMPurify } from '@/lib/utils/shared/document/domPurify';

import { validateImageSignature } from './imageSignature';

/**
 * Server-side SVG sanitisation.
 *
 * Plain magic-byte sniffing is not enough for SVG: it's an XML format and
 * can carry executable content (`<script>`, `on*` handlers, `<foreignObject>`,
 * `javascript:` hrefs). We deliberately *don't* admit raw SVG via the
 * binary `validateImageSignature` gate; instead, callers detect SVG with
 * `isSvgBuffer` and run `sanitizeSvgBuffer` before storage so anything
 * persisted to blob storage is already script-free.
 *
 * Rendering safety today comes from `<img src=data:image/svg+xml;base64,...>`,
 * which doesn't execute scripts in any modern browser, but sanitising at
 * upload is defence-in-depth: any future code path that ever serves the
 * stored bytes inline (object/embed/iframe/direct-navigation) inherits a
 * clean payload.
 */

/**
 * Cap on the input size we'll hand to DOMPurify. A real-world SVG icon is
 * a few KB; a complex inline diagram tops out around 100KB. 5MB is enough
 * headroom for any legitimate use while protecting the parser from
 * pathological inputs that could pin a worker.
 */
const MAX_SVG_BYTES = 5 * 1024 * 1024;

/**
 * Magic-byte detection for SVG content. Skips an optional UTF-8 BOM and
 * leading whitespace before checking for the `<?xml` prolog or `<svg`
 * root tag. Real-world SVG files frequently begin with one of these
 * variants, so a strict prefix match would miss them.
 */
export function isSvgBuffer(buffer: Buffer): boolean {
  if (buffer.length < 5) return false;
  let offset = 0;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    offset = 3;
  }
  while (
    offset < buffer.length &&
    (buffer[offset] === 0x20 ||
      buffer[offset] === 0x09 ||
      buffer[offset] === 0x0a ||
      buffer[offset] === 0x0d)
  ) {
    offset++;
  }
  if (buffer.length - offset < 5) return false;
  const head = buffer
    .subarray(offset, offset + 5)
    .toString('ascii')
    .toLowerCase();
  return head === '<?xml' || head.startsWith('<svg');
}

export type SvgSanitizationResult =
  | { ok: true; sanitized: Buffer }
  | { ok: false; error: string };

/**
 * Sanitise an SVG buffer with DOMPurify's SVG profile. Returns the
 * sanitised bytes on success, or a stable error string on rejection.
 *
 * Rejection cases:
 * - Input larger than `MAX_SVG_BYTES` — returned without invoking the
 *   parser to avoid spending CPU on inputs that have no legitimate reason
 *   to be that large.
 * - Sanitiser returns empty output — means DOMPurify couldn't recover any
 *   SVG content from the input (malformed XML, no `<svg>` root, etc.).
 *
 * Removals are *silent* by design: a benign SVG with editor-injected
 * cruft (Inkscape namespaces, RDF metadata) is cleaned and accepted, and
 * a hostile SVG with `<script>` is cleaned and accepted with the script
 * gone. If you need a hard-reject signal, count the input/output length
 * delta in the caller.
 */
export async function sanitizeSvgBuffer(
  buffer: Buffer,
): Promise<SvgSanitizationResult> {
  if (buffer.length > MAX_SVG_BYTES) {
    const limitMb = Math.round(MAX_SVG_BYTES / (1024 * 1024));
    return {
      ok: false,
      error: `SVG exceeds maximum size of ${limitMb}MB`,
    };
  }

  let svgString: string;
  try {
    svgString = buffer.toString('utf8');
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : 'Failed to decode SVG as UTF-8',
    };
  }

  const dompurify = await getDOMPurify();
  const sanitized = dompurify.sanitize(svgString, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // The svg profile already strips scripts and on* handlers; these are
    // belt-and-braces in case a future DOMPurify default loosens. They
    // also document intent for code readers.
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onclick', 'onerror', 'onmouseover'],
    KEEP_CONTENT: false,
  });

  if (!sanitized || sanitized.trim().length === 0) {
    return {
      ok: false,
      error: 'SVG content could not be parsed or was empty after sanitisation',
    };
  }

  return { ok: true, sanitized: Buffer.from(sanitized, 'utf8') };
}

/**
 * Single entry point for image-content validation that handles both binary
 * image formats and SVG. Callers in upload routes should use this instead
 * of branching on `isSvgBuffer` themselves — it keeps the SVG-vs-binary
 * decision in one place so a future change to the SVG policy (e.g., hard
 * reject vs sanitise) only updates here.
 *
 * Returns the bytes the caller should actually persist:
 * - For binary formats (PNG/JPEG/GIF/WebP/BMP/ICO) the input buffer is
 *   returned unchanged on success.
 * - For SVG the *sanitised* buffer is returned, with scripts and event
 *   handlers stripped. Callers must store this returned buffer rather
 *   than the input.
 */
export async function validateOrSanitizeImageBytes(
  data: Buffer,
): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
  if (isSvgBuffer(data)) {
    const result = await sanitizeSvgBuffer(data);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, data: result.sanitized };
  }
  const sig = validateImageSignature(data);
  if (!sig.isValid) {
    return { ok: false, error: sig.error ?? 'Invalid image content' };
  }
  return { ok: true, data };
}
