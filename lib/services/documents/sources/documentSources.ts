/**
 * Reading a DocumentSource (THE DOCUMENT SOURCE, documentSource.ts) on the
 * server, for the signed-in person only.
 *
 * Each kind has one reader. The documents layer registers `upload`;
 * features register their own kinds through lib/services/documentSources.ts,
 * so this layer never learns about them.
 */
import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { isValidFileId } from '@/lib/utils/server/file/fileId';
import {
  DocumentSource,
  isValidDocumentSource,
} from '@/lib/utils/shared/documents/documentSource';

/** A source's file as read. */
export interface DocumentFile {
  data: Buffer;
  /**
   * Its real type (extension, no dot): the source's, unless the store holds
   * it as another (an original kept in a legacy format).
   */
  type: string;
}

/** Reads one kind of source. */
export interface DocumentSourceReader {
  kind: string;
  /**
   * The file, or null when this person has no such file. Never throws for
   * a missing file; throws when the store fails.
   */
  read(session: Session, source: DocumentSource): Promise<DocumentFile | null>;
}

/** Raised for a source whose kind no reader handles. */
export class UnknownDocumentSourceError extends Error {
  constructor(readonly kind: string) {
    super(`No document source of kind "${kind}"`);
    this.name = 'UnknownDocumentSourceError';
  }
}

const readers = new Map<string, DocumentSourceReader>();

/**
 * Adds a reader for its kind; registering a kind again replaces it (a hot
 * reload in development).
 */
export function registerDocumentSource(reader: DocumentSourceReader): void {
  readers.set(reader.kind, reader);
}

/** Whether a kind can be read. */
export function hasDocumentSource(kind: string): boolean {
  return readers.has(kind);
}

/**
 * The file of a source, for this person.
 *
 * @returns The file, or null when it is malformed or this person has no
 *   such file.
 * @throws UnknownDocumentSourceError when no reader handles its kind.
 * @throws The store's error when reading fails for another reason.
 */
export async function readDocumentSource(
  session: Session,
  source: DocumentSource,
): Promise<DocumentFile | null> {
  if (!isValidDocumentSource(source)) return null;
  const reader = readers.get(source.kind);
  if (!reader) throw new UnknownDocumentSourceError(source.kind);
  return reader.read(session, source);
}

/** A data URL as the upload route stores an image: `data:<mime>;base64,`. */
const STORED_DATA_URL = /^data:[a-zA-Z0-9!#$&^_.+/-]+;base64,/;

/**
 * An upload's bytes as stored. The upload route keeps an image as its
 * data URL text (sanitised, for SVG), not as the image's bytes; every
 * other file is kept as it is.
 *
 * @param stored - The blob's content.
 * @returns The file's own bytes.
 */
export function storedUploadBytes(stored: Buffer): Buffer {
  const head = stored.subarray(0, 120).toString('latin1');
  const prefix = STORED_DATA_URL.exec(head);
  if (!prefix) return stored;
  return Buffer.from(
    stored.subarray(prefix[0].length).toString('latin1'),
    'base64',
  );
}

/**
 * Keeps a file a feature made for the person as one of their uploads, so
 * every reader of uploads (the viewer, downloads, reviews) takes it.
 * Uploads are kept by their content's hash: the same file is kept once.
 *
 * @param type - Its extension, no dot (`pptx`).
 * @returns Its reference, `/api/file/<sha256>.<type>`.
 */
export async function storeUploadedFile(
  session: Session,
  data: Uint8Array,
  type: string,
  contentType: string,
): Promise<string> {
  const bytes = Buffer.from(data);
  const id = `${Hasher.sha256(bytes)}.${type}`;
  await createBlobStorageClient(session).upload(
    `${getUserIdFromSession(session)}/uploads/files/${id}`,
    bytes,
    { blobHTTPHeaders: { blobContentType: contentType } },
  );
  return `/api/file/${id}`;
}

/**
 * A person's uploaded files (`/api/file/<id>`). They are stored under the
 * owner's own prefix, so another person's id resolves to nothing; the id's
 * extension must be the source's type. An image comes back as its bytes,
 * not as the data URL text it is stored as.
 */
export const uploadDocumentSource: DocumentSourceReader = {
  kind: 'upload',
  async read(session, source) {
    if (!isValidFileId(source.id)) return null;
    if (source.id.split('.').pop()?.toLowerCase() !== source.type) return null;
    const userId = getUserIdFromSession(session);
    try {
      const data = (await createBlobStorageClient(session).get(
        `${userId}/uploads/files/${source.id}`,
        BlobProperty.BLOB,
      )) as Buffer;
      return { data: storedUploadBytes(data), type: source.type };
    } catch (error) {
      if (isBlobNotFoundError(error)) return null;
      throw error;
    }
  },
};

registerDocumentSource(uploadDocumentSource);
