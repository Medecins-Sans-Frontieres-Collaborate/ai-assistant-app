import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { isValidFileId } from '@/lib/utils/server/file/fileId';

import { NativePdfPageOutput } from './nativePdfPipeline';

/**
 * Where a native PDF run keeps its files.
 *
 * Everything is stored under the user's own upload folders with the same
 * content-hash naming as uploads, so the existing `/api/file/<id>` route
 * serves it with per-user access control and identical content is stored
 * once. A run therefore needs no job record: the client holds the ids of
 * the source PDF and the extraction, and sends them back to edit the run.
 */

const KINDS = {
  pdf: { folder: 'files', contentType: 'application/pdf' },
  json: { folder: 'files', contentType: 'application/json' },
  png: { folder: 'images', contentType: 'image/png' },
} as const;

export type NativePdfFileKind = keyof typeof KINDS;

export interface StoredNativeFile {
  /** `<sha256>.<ext>`: what a later request sends back to name this file. */
  id: string;
  /** Path the browser loads it from. */
  url: string;
}

export interface StoredNativePage {
  page: number;
  /** PNG of the translated page. */
  previewUrl: string;
  /** PNG of the original beside the translated page. */
  checkUrl: string;
}

/**
 * Stores one file of a run.
 *
 * @param session - The signed-in user; the file lands in their folder.
 * @param data - The file's bytes.
 * @param kind - What the file is, which decides its folder and content type.
 * @returns The file's id and the path it is served from.
 * @throws When blob storage refuses the upload.
 */
export async function storeNativeFile(
  session: Session,
  data: Uint8Array,
  kind: NativePdfFileKind,
): Promise<StoredNativeFile> {
  const buffer = Buffer.from(data);
  const id = `${Hasher.sha256(buffer)}.${kind}`;
  const { folder, contentType } = KINDS[kind];
  await createBlobStorageClient(session).upload(
    `${getUserIdFromSession(session)}/uploads/${folder}/${id}`,
    buffer,
    { blobHTTPHeaders: { blobContentType: contentType } },
  );
  // The file route looks in the image folder only when told to.
  return {
    id,
    url: `/api/file/${id}${folder === 'images' ? '?filetype=image' : ''}`,
  };
}

/**
 * Whether a value names a stored file of the given kind.
 *
 * @param id - Untrusted input.
 * @param kind - The kind the caller expects.
 */
export function isNativeFileId(
  id: unknown,
  kind: NativePdfFileKind,
): id is string {
  return typeof id === 'string' && id.endsWith(`.${kind}`) && isValidFileId(id);
}

/**
 * Reads back a file of a run from the user's own folder.
 *
 * @param session - The signed-in user; only their folder is read.
 * @param id - An id accepted by {@link isNativeFileId} for `kind`.
 * @param kind - The file's kind.
 * @returns The file's bytes.
 * @throws A blob-storage error when the file does not exist (see
 *   `isBlobNotFoundError`) or cannot be read.
 */
export async function readNativeFile(
  session: Session,
  id: string,
  kind: NativePdfFileKind,
): Promise<Buffer> {
  return (await createBlobStorageClient(session).get(
    `${getUserIdFromSession(session)}/uploads/${KINDS[kind].folder}/${id}`,
    BlobProperty.BLOB,
  )) as Buffer;
}

/**
 * Stores a rebuild's PDF and page images.
 *
 * @param session - The signed-in user.
 * @param built - The rebuild's PDF and per-page images.
 * @returns Where the PDF and each page's images are served from.
 */
export async function storeNativeRebuild(
  session: Session,
  built: { pdf: Uint8Array; outputs: NativePdfPageOutput[] },
): Promise<{ pdfUrl: string; pageImages: StoredNativePage[] }> {
  const [pdf, pageImages] = await Promise.all([
    storeNativeFile(session, built.pdf, 'pdf'),
    Promise.all(
      built.outputs.map(async (output) => {
        const [preview, check] = await Promise.all([
          storeNativeFile(session, output.preview, 'png'),
          storeNativeFile(session, output.check, 'png'),
        ]);
        return {
          page: output.page,
          previewUrl: preview.url,
          checkUrl: check.url,
        };
      }),
    ),
  ]);
  return { pdfUrl: pdf.url, pageImages };
}
