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

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { isValidFileId } from '@/lib/utils/server/file/fileId';
import {
  DocumentSource,
  isValidDocumentSource,
} from '@/lib/utils/shared/documents/documentSource';

/** Reads one kind of source. */
export interface DocumentSourceReader {
  kind: string;
  /**
   * The file's bytes, or null when this person has no such file. Never
   * throws for a missing file; throws when the store fails.
   */
  read(session: Session, source: DocumentSource): Promise<Buffer | null>;
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
 * The bytes of a source, for this person.
 *
 * @returns The file, or null when it is malformed or this person has no
 *   such file.
 * @throws UnknownDocumentSourceError when no reader handles its kind.
 * @throws The store's error when reading fails for another reason.
 */
export async function readDocumentSource(
  session: Session,
  source: DocumentSource,
): Promise<Buffer | null> {
  if (!isValidDocumentSource(source)) return null;
  const reader = readers.get(source.kind);
  if (!reader) throw new UnknownDocumentSourceError(source.kind);
  return reader.read(session, source);
}

/**
 * A person's uploaded files (`/api/file/<id>`). They are stored under the
 * owner's own prefix, so another person's id resolves to nothing; the id's
 * extension must be the source's type.
 */
export const uploadDocumentSource: DocumentSourceReader = {
  kind: 'upload',
  async read(session, source) {
    if (!isValidFileId(source.id)) return null;
    if (source.id.split('.').pop()?.toLowerCase() !== source.type) return null;
    const userId = getUserIdFromSession(session);
    try {
      return (await createBlobStorageClient(session).get(
        `${userId}/uploads/files/${source.id}`,
        BlobProperty.BLOB,
      )) as Buffer;
    } catch (error) {
      if (isBlobNotFoundError(error)) return null;
      throw error;
    }
  },
};

registerDocumentSource(uploadDocumentSource);
