/**
 * Content-vs-name check for documents pulled out of OneDrive/SharePoint
 * before they reach the extraction toolchain (pandoc / LibreOffice / pdfjs).
 *
 * `fileValidation.ts` only knows audio/video/image signatures, so document
 * containers get their own small table here. The point is not forensic
 * accuracy — it is refusing to hand a renamed executable or a mislabeled
 * archive to a parser that trusts the extension.
 */

export type DocumentContainer = 'pdf' | 'zip' | 'ole' | 'rtf' | 'text';

export interface DocumentSignatureResult {
  ok: boolean;
  /** What the leading bytes look like, when recognised. */
  detected?: DocumentContainer;
  error?: string;
}

/** Expected container per indexable extension (lowercase, no dot). */
const EXPECTED_CONTAINER: Record<string, DocumentContainer[]> = {
  pdf: ['pdf'],
  docx: ['zip'],
  pptx: ['zip'],
  xlsx: ['zip'],
  odt: ['zip'],
  epub: ['zip'],
  doc: ['ole'],
  ppt: ['ole'],
  rtf: ['rtf', 'text'],
  txt: ['text'],
  md: ['text'],
  markdown: ['text'],
  csv: ['text'],
  tsv: ['text'],
  json: ['text'],
  html: ['text'],
  htm: ['text'],
  xhtml: ['text'],
  xml: ['text'],
  tex: ['text'],
  py: ['text'],
  sql: ['text'],
};

/** Extensions this module can vouch for (also the indexable set). */
export const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(EXPECTED_CONTAINER),
);

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

/**
 * A text container is anything without NUL bytes in its leading window
 * (UTF-8/ASCII/Latin-1 all satisfy this; UTF-16 with a BOM is accepted via
 * the BOM branch because the extraction path reads it as text anyway).
 */
function looksLikeText(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (startsWith(window, [0xff, 0xfe]) || startsWith(window, [0xfe, 0xff])) {
    return true;
  }
  return !window.includes(0);
}

export function detectDocumentContainer(
  buffer: Buffer,
): DocumentContainer | undefined {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'zip'; // PK..
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0])) return 'ole';
  if (startsWith(buffer, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf'; // {\rtf
  if (looksLikeText(buffer)) return 'text';
  return undefined;
}

/**
 * Verifies that the downloaded bytes are the kind of container the
 * extension claims. Unknown extensions fail closed — the planner should
 * never have let them through.
 */
export function checkDocumentSignature(
  buffer: Buffer,
  extension: string,
): DocumentSignatureResult {
  const expected = EXPECTED_CONTAINER[extension.toLowerCase()];
  if (!expected) {
    return { ok: false, error: `Extension .${extension} is not indexable` };
  }
  if (buffer.length === 0) {
    return { ok: false, error: 'Empty file' };
  }
  const detected = detectDocumentContainer(buffer);
  if (detected && expected.includes(detected)) {
    return { ok: true, detected };
  }
  return {
    ok: false,
    detected,
    error: `Content does not look like a .${extension} file (${detected ?? 'unrecognised container'})`,
  };
}
