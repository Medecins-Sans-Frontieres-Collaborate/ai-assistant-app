/**
 * Brand books on the server: their files, and who may use them
 * (docs/DOCUMENT_PLATFORM.md, phase E).
 *
 * THE BRAND FILE CONVENTION (stated once; the routes and tests cite it):
 *  - A file in a brand book is referenced one of two ways:
 *      `/api/file/<sha256>.<ext>`  an admin's own upload, only while the
 *                                  book is being saved;
 *      `admin:<book id>/<name>`    the book's stored copy in the admin
 *                                  container, `<name>` being the first 32
 *                                  hex digits of its SHA-256 and its type.
 *    Saving copies every upload into the book and rewrites its reference,
 *    so people using the book never read an admin's personal blobs, and
 *    refuses a reference to another book's file.
 *  - Each place takes its own types (BRAND_FILE_TYPES): a logo is an image,
 *    a template an Office template or document, the source a PDF.
 *  - A stored file is readable only by people the book's access rule
 *    allows (`brand-book::<id>`), and only while the book exists and still
 *    references it: the same answer as a missing file otherwise, so the
 *    file route is no existence oracle.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  listAllBrandBooks,
  readBrandBook,
} from '@/lib/services/agentAccess/accessRulesStore';
import { downloadBlob } from '@/lib/services/agentAccess/blobCas';
import {
  AGENT_ACCESS_BRAND_BOOK_FILES_PREFIX,
  AdminBrandBook,
  BRAND_BOOK_ID_PATTERN,
  BRAND_BOOK_SOURCE,
  brandBookFileBlobPath,
} from '@/lib/services/agentAccess/types';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { BrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import { createHash } from 'crypto';

/** Largest file a brand book may hold. */
export const MAX_BRAND_FILE_BYTES = 50 * 1024 * 1024;

/** The types each place in a brand book takes (THE BRAND FILE CONVENTION). */
export const BRAND_FILE_TYPES = {
  logo: ['png', 'svg', 'jpg', 'jpeg'],
  template: ['potx', 'pptx', 'dotx', 'docx'],
  source: ['pdf'],
} as const;

export type BrandFilePlace = keyof typeof BRAND_FILE_TYPES;

/** Content types the file route serves. */
export const BRAND_FILE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const UPLOAD_REF = /^\/api\/file\/([a-f0-9]{64})\.([a-z0-9]{2,5})$/;
const STORED_REF =
  /^admin:(brand-[a-f0-9]{12})\/([a-f0-9]{32}\.[a-z0-9]{2,5})$/;
const STORED_NAME = /^[a-f0-9]{32}\.([a-z0-9]{2,5})$/;

/** A file reference, read (THE BRAND FILE CONVENTION). */
export type BrandFileRef =
  | { kind: 'upload'; blobName: string; ext: string }
  | { kind: 'stored'; bookId: string; name: string; ext: string };

/** A save refused because of a file, with what to tell the admin. */
export class BrandFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandFileError';
  }
}

/** Reads a reference; null for any other shape. */
export function parseBrandFileRef(ref: string): BrandFileRef | null {
  const upload = UPLOAD_REF.exec(ref.trim());
  if (upload) {
    return {
      kind: 'upload',
      blobName: `${upload[1]}.${upload[2]}`,
      ext: upload[2],
    };
  }
  const stored = STORED_REF.exec(ref.trim());
  if (stored && BRAND_BOOK_ID_PATTERN.test(stored[1])) {
    return {
      kind: 'stored',
      bookId: stored[1],
      name: stored[2],
      ext: stored[2].split('.')[1],
    };
  }
  return null;
}

/** A stored file's reference. */
export function storedBrandFileRef(bookId: string, name: string): string {
  return `admin:${bookId}/${name}`;
}

/** Every file a book references, with the place it is in. */
export function brandBookFiles(
  book: BrandBookBody,
): Array<{ ref: string; place: BrandFilePlace }> {
  return [
    ...book.logos.map((logo) => ({ ref: logo.file, place: 'logo' as const })),
    ...book.templates.map((template) => ({
      ref: template.file,
      place: 'template' as const,
    })),
    ...(book.source
      ? [{ ref: book.source.file, place: 'source' as const }]
      : []),
  ];
}

/** What reading an admin's own upload needs; replaced in tests. */
export interface BrandFileStore {
  readUpload(session: Session, blobName: string): Promise<Buffer>;
  storedExists(bookId: string, name: string): Promise<boolean>;
  writeStored(bookId: string, name: string, data: Buffer): Promise<void>;
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
export function uploadBytes(stored: Buffer): Buffer {
  const head = stored.subarray(0, 120).toString('latin1');
  const prefix = STORED_DATA_URL.exec(head);
  if (!prefix) return stored;
  return Buffer.from(
    stored.subarray(prefix[0].length).toString('latin1'),
    'base64',
  );
}

/** Base64 holds 3 bytes in 4 characters, plus the data URL's prefix. */
const STORED_SIZE_ALLOWANCE = 1.4;

const blobFileStore: BrandFileStore = {
  async readUpload(session, blobName) {
    const storage = createBlobStorageClient(session);
    const path = `${getUserIdFromSession(session)}/uploads/files/${blobName}`;
    const tooLarge = () =>
      new BrandFileError('A file is larger than a brand book takes (50 MB).');
    // Measured before reading, with room for an image's data URL; the
    // decoded size is checked exactly below.
    if (
      (await storage.getBlobSize(path)) >
      MAX_BRAND_FILE_BYTES * STORED_SIZE_ALLOWANCE
    ) {
      throw tooLarge();
    }
    const data = uploadBytes(
      (await storage.get(path, BlobProperty.BLOB)) as Buffer,
    );
    if (data.length > MAX_BRAND_FILE_BYTES) throw tooLarge();
    return data;
  },
  async storedExists(bookId, name) {
    return createAgentAccessBlobStorage()
      .getBlockBlobClient(brandBookFileBlobPath(bookId, name))
      .exists();
  },
  async writeStored(bookId, name, data) {
    const ext = name.split('.')[1];
    await createAgentAccessBlobStorage()
      .getBlockBlobClient(brandBookFileBlobPath(bookId, name))
      .uploadData(data, {
        blobHTTPHeaders: {
          blobContentType:
            BRAND_FILE_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        },
      });
  },
};

/**
 * Reads one of the signed-in admin's own uploads by its reference.
 *
 * @param place - The place it is for, which decides the types accepted.
 * @throws BrandFileError for another shape or type, or a file too large.
 */
export async function readBrandUpload(
  session: Session,
  ref: string,
  place: BrandFilePlace,
  store: BrandFileStore = blobFileStore,
): Promise<{ data: Buffer; ext: string }> {
  const parsed = parseBrandFileRef(ref);
  if (!parsed || parsed.kind !== 'upload') {
    throw new BrandFileError(`"${ref}" is not an upload of yours.`);
  }
  const allowed: readonly string[] = BRAND_FILE_TYPES[place];
  if (!allowed.includes(parsed.ext)) {
    throw new BrandFileError(
      `A ${place} must be ${allowed.map((ext) => `.${ext}`).join(', ')}; this one is .${parsed.ext}.`,
    );
  }
  const data = await store.readUpload(session, parsed.blobName);
  if (data.length > MAX_BRAND_FILE_BYTES) {
    throw new BrandFileError(
      'A file is larger than a brand book takes (50 MB).',
    );
  }
  return { data, ext: parsed.ext };
}

/**
 * Copies a book's uploads into it and rewrites their references (THE
 * BRAND FILE CONVENTION).
 *
 * @param bookId - The book being saved.
 * @returns The book with every reference a stored one.
 * @throws BrandFileError for a reference of the wrong shape or type, to
 *   another book, to a stored file that is gone, or to a file too large.
 */
export async function settleBrandBookFiles(
  session: Session,
  bookId: string,
  book: BrandBookBody,
  store: BrandFileStore = blobFileStore,
): Promise<BrandBookBody> {
  const settled = new Map<string, string>();
  for (const { ref, place } of brandBookFiles(book)) {
    if (settled.has(ref)) continue;
    const parsed = parseBrandFileRef(ref);
    if (!parsed) throw new BrandFileError(`"${ref}" is not a file reference.`);
    const allowed: readonly string[] = BRAND_FILE_TYPES[place];
    if (!allowed.includes(parsed.ext)) {
      throw new BrandFileError(
        `A ${place} must be ${allowed.map((ext) => `.${ext}`).join(', ')}; this one is .${parsed.ext}.`,
      );
    }
    if (parsed.kind === 'stored') {
      if (parsed.bookId !== bookId) {
        throw new BrandFileError('A file belongs to another brand book.');
      }
      if (!(await store.storedExists(bookId, parsed.name))) {
        throw new BrandFileError(
          'A file of this brand book is missing; upload it again.',
        );
      }
      settled.set(ref, ref);
      continue;
    }
    const data = await store.readUpload(session, parsed.blobName);
    if (data.length > MAX_BRAND_FILE_BYTES) {
      throw new BrandFileError(
        'A file is larger than a brand book takes (50 MB).',
      );
    }
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.${parsed.ext}`;
    await store.writeStored(bookId, name, data);
    settled.set(ref, storedBrandFileRef(bookId, name));
  }
  const settle = (ref: string) => settled.get(ref) ?? ref;
  return {
    ...book,
    logos: book.logos.map((logo) => ({ ...logo, file: settle(logo.file) })),
    templates: book.templates.map((template) => ({
      ...template,
      file: settle(template.file),
    })),
    ...(book.source
      ? { source: { ...book.source, file: settle(book.source.file) } }
      : {}),
  };
}

/**
 * Removes a book's stored files it no longer references (all of them for
 * a deleted book). Best effort: an orphan is unreadable anyway.
 *
 * @param keep - The book as saved, or null when it was deleted.
 */
export async function removeUnusedBrandBookFiles(
  bookId: string,
  keep: BrandBookBody | null,
): Promise<void> {
  const used = new Set(
    (keep ? brandBookFiles(keep) : [])
      .map(({ ref }) => parseBrandFileRef(ref))
      .filter(
        (ref): ref is Extract<BrandFileRef, { kind: 'stored' }> =>
          ref?.kind === 'stored',
      )
      .map((ref) => ref.name),
  );
  const storage = createAgentAccessBlobStorage();
  const prefix = `${AGENT_ACCESS_BRAND_BOOK_FILES_PREFIX}${bookId}/`;
  const names = await storage.listBlobs(prefix);
  await Promise.all(
    names
      .map((name) => name.slice(name.lastIndexOf('/') + 1))
      .filter((name) => !used.has(name))
      .map((name) =>
        storage.deleteIfExists(brandBookFileBlobPath(bookId, name)),
      ),
  );
}

/**
 * Whether the person may use a brand book: its access rule allows them
 * and it exists.
 *
 * @param req - The request, so group rules can apply; without it only
 *   person and domain rules do.
 * @returns The book when they may, else null.
 */
export async function usableBrandBook(
  session: Session,
  bookId: string,
  req?: NextRequest,
): Promise<AdminBrandBook | null> {
  if (!BRAND_BOOK_ID_PATTERN.test(bookId)) return null;
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return null;
  if (req) await resolveUserGroupIds(req, session);
  await service.ensureFresh();
  const allowed =
    service.evaluateAccess({
      userMail: session.user.mail ?? undefined,
      source: BRAND_BOOK_SOURCE,
      agentName: bookId,
    }).decision === 'allow';
  if (!allowed) return null;
  const stored = await readBrandBook(createAgentAccessBlobStorage(), bookId);
  return stored?.record ?? null;
}

/**
 * The brand books the person may use (their access rules), for a listing.
 *
 * @param req - The request, so group rules apply.
 */
export async function usableBrandBooks(
  session: Session,
  req: NextRequest,
): Promise<AdminBrandBook[]> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return [];
  // Group warm-up must come before evaluateAccess, which reads it.
  await resolveUserGroupIds(req, session);
  await service.ensureFresh();
  const stored = await listAllBrandBooks(createAgentAccessBlobStorage());
  return stored
    .filter(
      (entry) =>
        service.evaluateAccess({
          userMail: session.user.mail ?? undefined,
          source: BRAND_BOOK_SOURCE,
          agentName: entry.record.id,
        }).decision === 'allow',
    )
    .map((entry) => entry.record);
}

/**
 * A stored file of a book, read WITHOUT an access check: the caller must
 * have checked the person may edit the book (the admin editor) or use it
 * (a brand review the route started). Referenced or not (a file just
 * replaced may still be shown until the book is saved).
 *
 * @returns Its bytes and content type, or null for another name or none.
 */
export async function readStoredBrandFile(
  bookId: string,
  name: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  const match = STORED_NAME.exec(name);
  if (!match || !BRAND_BOOK_ID_PATTERN.test(bookId)) return null;
  const result = await downloadBlob(
    createAgentAccessBlobStorage(),
    brandBookFileBlobPath(bookId, name),
    'brandBookFile',
  );
  if (!result) return null;
  return {
    data: result.buffer,
    contentType:
      BRAND_FILE_CONTENT_TYPES[match[1]] ?? 'application/octet-stream',
  };
}

/**
 * A stored file of a book the person may use, if the book references it
 * (THE BRAND FILE CONVENTION).
 *
 * @returns Its bytes and content type, or null (no access, no book, not
 *   referenced, or gone: one answer for all).
 */
export async function readBrandBookFile(
  session: Session,
  bookId: string,
  name: string,
  req?: NextRequest,
): Promise<{ data: Buffer; contentType: string } | null> {
  const match = STORED_NAME.exec(name);
  if (!match) return null;
  const book = await usableBrandBook(session, bookId, req);
  if (!book) return null;
  const referenced = brandBookFiles(book.book).some(
    ({ ref }) => ref === storedBrandFileRef(bookId, name),
  );
  if (!referenced) return null;
  const result = await downloadBlob(
    createAgentAccessBlobStorage(),
    brandBookFileBlobPath(bookId, name),
    'brandBookFile',
  );
  if (!result) return null;
  return {
    data: result.buffer,
    contentType:
      BRAND_FILE_CONTENT_TYPES[match[1]] ?? 'application/octet-stream',
  };
}
