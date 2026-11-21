/**
 * What a deck is built from, read for the person: the template (one of a
 * brand book's, or the person's own upload), source documents as text,
 * and pictures (the book's logos and the person's images).
 *
 * THE PICTURE KEYS (stated once; the planner, the build and the UI cite
 * them): a book logo is `logo:<logo id>`, a person's picture is
 * `picture:<n>` (1-based, in the order they were given).
 */
import { Session } from 'next-auth';

import {
  parseBrandFileRef,
  readStoredBrandFile,
} from '@/lib/services/brand/brandBooks';
import {
  readDocumentSource,
  storedUploadBytes,
} from '@/lib/services/documents/sources/documentSources';

import { loadDocumentFromPath } from '@/lib/utils/server/file/fileHandling';
import { BrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Template types a deck is built from. */
export const DECK_TEMPLATE_TYPES: readonly string[] = ['pptx', 'potx'];
/** Source documents read as text. */
export const DECK_SOURCE_TYPES: readonly string[] = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'txt',
  'md',
  'csv',
];
/** The MIME type each source type is read as (the extractor picks by it). */
const SOURCE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};
/** Pictures the engine places (deck_engine: PNG, JPEG or GIF). */
export const DECK_PICTURE_TYPES: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
];
/** At most this many sources and pictures are read for one deck. */
export const MAX_DECK_SOURCES = 5;
export const MAX_DECK_PICTURES = 10;
/** Text kept from one source, and from all of them. */
export const MAX_SOURCE_CHARS = 40_000;
export const MAX_SOURCES_CHARS = 80_000;

const UPLOAD_REF = /^\/api\/file\/([a-f0-9]{64}\.([a-z0-9]{2,5}))$/;

/** One of the person's uploads, as a request names it. */
export interface DeckUpload {
  /** `/api/file/<sha256>.<ext>`. */
  file: string;
  /** Its name as the person knows it. */
  name: string;
}

/** The template a deck is built from. */
export interface DeckTemplateRef {
  /** A book's stored file (`admin:<book>/<name>`) or the person's upload. */
  file: string;
  name: string;
  /** `pptx` or `potx`. */
  type: string;
}

/** A picture the deck may place, by its key (THE PICTURE KEYS). */
export interface DeckPicture {
  key: string;
  name: string;
  /** Where it comes from, for the planner: a logo is the brand's mark. */
  kind: 'logo' | 'picture';
  /** A book's stored file or the person's upload. */
  file: string;
}

/** Raised for an input the person cannot use; its message says why. */
export class DeckInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckInputError';
  }
}

/**
 * One of the person's uploads, by reference, when its type is one of
 * `types`.
 *
 * @returns Its id and type, or null for any other reference.
 */
export function parseDeckUpload(
  ref: string,
  types: readonly string[],
): { id: string; type: string } | null {
  const match = UPLOAD_REF.exec(ref);
  if (!match || !types.includes(match[2])) return null;
  return { id: match[1], type: match[2] };
}

/**
 * Whether a template reference can be used: one of the book's deck
 * templates, or the person's own .pptx or .potx upload.
 *
 * @param book - The book the deck is built for, if any.
 * @returns The template's type, or null when it cannot be used.
 */
export function deckTemplateType(
  ref: string,
  book: BrandBookBody | null,
): string | null {
  const upload = parseDeckUpload(ref, DECK_TEMPLATE_TYPES);
  if (upload) return upload.type;
  const stored = parseBrandFileRef(ref);
  if (stored?.kind !== 'stored' || !book) return null;
  const listed = book.templates.find((template) => template.file === ref);
  return listed && DECK_TEMPLATE_TYPES.includes(listed.type)
    ? listed.type
    : null;
}

/**
 * The pictures a deck may place: the book's logos the engine can place
 * (not SVG), then the person's pictures (THE PICTURE KEYS).
 */
export function deckPictures(
  book: BrandBookBody | null,
  uploads: readonly DeckUpload[],
): DeckPicture[] {
  const logos: DeckPicture[] = (book?.logos ?? [])
    .filter((logo) =>
      DECK_PICTURE_TYPES.includes(logo.file.split('.').pop() ?? ''),
    )
    .map((logo) => ({
      key: `logo:${logo.id}`,
      name: logo.name,
      kind: 'logo',
      file: logo.file,
    }));
  const pictures: DeckPicture[] = uploads
    .slice(0, MAX_DECK_PICTURES)
    .map((upload, index) => ({
      key: `picture:${index + 1}`,
      name: upload.name,
      kind: 'picture',
      file: upload.file,
    }));
  return [...logos, ...pictures];
}

/**
 * Reads a book's stored file or the person's upload, as bytes.
 *
 * @param bookId - The book a stored file must belong to.
 * @returns The bytes, or null when the file is gone or not theirs.
 */
export async function readDeckFile(
  session: Session,
  ref: string,
  bookId: string | null,
): Promise<Buffer | null> {
  const stored = parseBrandFileRef(ref);
  if (stored?.kind === 'stored') {
    if (stored.bookId !== bookId) return null;
    return (
      (await readStoredBrandFile(stored.bookId, stored.name))?.data ?? null
    );
  }
  const upload = UPLOAD_REF.exec(ref);
  if (!upload) return null;
  const file = await readDocumentSource(session, {
    kind: 'upload',
    id: upload[1],
    type: upload[2],
  });
  return file ? storedUploadBytes(file.data) : null;
}

/**
 * A source document's text, cut to `MAX_SOURCE_CHARS`.
 *
 * @throws DeckInputError when the file is gone or holds no text.
 */
export async function readSourceText(
  session: Session,
  source: DeckUpload,
): Promise<string> {
  const upload = parseDeckUpload(source.file, DECK_SOURCE_TYPES);
  if (!upload) throw new DeckInputError(`${source.name} cannot be read.`);
  const data = await readDeckFile(session, source.file, null);
  if (!data) throw new DeckInputError(`${source.name} is no longer stored.`);
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'deck-source-'),
  );
  try {
    // A fixed name: nothing from the request reaches a path but the type.
    const filePath = path.join(workDir, `source.${upload.type}`);
    await fs.promises.writeFile(filePath, data);
    const text = (
      await loadDocumentFromPath(
        filePath,
        SOURCE_MIME_TYPES[upload.type],
        `source.${upload.type}`,
      )
    ).trim();
    if (!text) throw new DeckInputError(`${source.name} holds no text.`);
    return text.slice(0, MAX_SOURCE_CHARS);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
