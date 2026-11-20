/**
 * What LibreOffice is allowed to open, and how.
 *
 * LibreOffice guesses a file's type when it is not told: random bytes named
 * `.pptx` were opened as a Writer document and "converted" into a PDF of
 * garbage (probe, docs/POWERPOINT_TRANSLATION.md). So every input is
 * checked against the signature its type must start with, and opened with
 * its import filter named. The filter names are LibreOffice's own; each was
 * verified on LibreOffice 25.8 (the production image's).
 */
import fs from 'fs';

/** The container a file's first bytes say it is. */
export type FileSignature = 'zip' | 'cfb' | 'rtf' | 'pdf' | 'unknown';

/** A document type LibreOffice may open, by extension. */
export interface LibreOfficeInput {
  /** What the file must start with. */
  signature: Exclude<FileSignature, 'unknown'>;
  /** LibreOffice's import filter for it. */
  filter: string;
}

const POWERPOINT_XML: LibreOfficeInput = {
  signature: 'zip',
  filter: 'Impress MS PowerPoint 2007 XML',
};
const POWERPOINT_97: LibreOfficeInput = {
  signature: 'cfb',
  filter: 'MS PowerPoint 97',
};

/**
 * Every type LibreOffice is used for, by extension (lowercase, no dot).
 * The PowerPoint XML filter also opens macro-enabled decks, shows and
 * templates (verified), so they share it.
 */
export const LIBREOFFICE_INPUTS: Readonly<Record<string, LibreOfficeInput>> = {
  pptx: POWERPOINT_XML,
  pptm: POWERPOINT_XML,
  ppsx: POWERPOINT_XML,
  potx: POWERPOINT_XML,
  ppt: POWERPOINT_97,
  pps: POWERPOINT_97,
  pot: POWERPOINT_97,
  odp: { signature: 'zip', filter: 'impress8' },
  docx: { signature: 'zip', filter: 'MS Word 2007 XML' },
  doc: { signature: 'cfb', filter: 'MS Word 97' },
  odt: { signature: 'zip', filter: 'writer8' },
  rtf: { signature: 'rtf', filter: 'Rich Text Format' },
};

/** The document types LibreOffice may open. */
export type LibreOfficeInputType = keyof typeof LIBREOFFICE_INPUTS;

/** Whether LibreOffice may open files of this extension. */
export function isLibreOfficeInputType(
  extension: string,
): extension is LibreOfficeInputType {
  return Object.prototype.hasOwnProperty.call(
    LIBREOFFICE_INPUTS,
    extension.toLowerCase(),
  );
}

/** Leading bytes of each signature. */
const SIGNATURES: ReadonlyArray<[FileSignature, number[]]> = [
  ['zip', [0x50, 0x4b, 0x03, 0x04]],
  ['cfb', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ['rtf', [0x7b, 0x5c, 0x72, 0x74, 0x66]], // {\rtf
  ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
];

/**
 * The container `head` (a file's first bytes) starts with.
 *
 * @param head - At least the first 8 bytes; fewer give 'unknown' unless a
 *   shorter signature matches.
 */
export function signatureOf(head: Uint8Array): FileSignature {
  for (const [name, bytes] of SIGNATURES) {
    if (bytes.every((byte, at) => head[at] === byte)) return name;
  }
  return 'unknown';
}

/** Reads a file's first bytes and says what container it is. */
export async function readSignature(filePath: string): Promise<FileSignature> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const head = new Uint8Array(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return signatureOf(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Raised when a file is not what its type says. An Office Open XML file
 * (a zip) that is a compound file instead is password protected or
 * encrypted by a sensitivity label: `protected` is true for that case.
 */
export class DocumentSignatureError extends Error {
  readonly code: 'DOCUMENT_PROTECTED' | 'DOCUMENT_UNREADABLE';
  constructor(
    readonly type: string,
    readonly found: FileSignature,
  ) {
    const expected = LIBREOFFICE_INPUTS[type]?.signature;
    const isProtected = expected === 'zip' && found === 'cfb';
    super(
      isProtected
        ? `This .${type} file is password protected or encrypted, so it cannot be opened. Remove the protection and upload it again.`
        : `This file is not a readable .${type} file (it looks like ${found === 'unknown' ? 'something else' : `a ${found} file`}).`,
    );
    this.name = 'DocumentSignatureError';
    this.code = isProtected ? 'DOCUMENT_PROTECTED' : 'DOCUMENT_UNREADABLE';
  }
}

/**
 * Checks that a file is the type it claims and returns how to open it.
 *
 * @param filePath - The file on disk.
 * @param type - Its declared type (extension, no dot).
 * @returns The type's signature and import filter.
 * @throws Error when LibreOffice is not used for `type`.
 * @throws DocumentSignatureError when the file does not start as `type` must.
 */
export async function checkLibreOfficeInput(
  filePath: string,
  type: string,
): Promise<LibreOfficeInput> {
  const normalized = type.toLowerCase();
  if (!isLibreOfficeInputType(normalized)) {
    throw new Error(`LibreOffice is not used for .${normalized} files`);
  }
  const input = LIBREOFFICE_INPUTS[normalized];
  const found = await readSignature(filePath);
  if (found !== input.signature) {
    throw new DocumentSignatureError(normalized, found);
  }
  return input;
}
