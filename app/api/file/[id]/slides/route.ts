import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { deckPdfExport } from '@/lib/services/documentTranslation/native/formats/deckFormat';
import { renderErrorResponse } from '@/lib/services/presentationRender/renderErrorResponse';
import { getRenderService } from '@/lib/services/presentationRender/renderService';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { isValidFileId } from '@/lib/utils/server/file/fileId';
import {
  NATIVE_DECK_MAX_BYTES,
  nativeUploadExtension,
} from '@/lib/utils/shared/translation/nativeFormats';

import { auth } from '@/auth';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** A large deck takes a while to lay out, and may wait for a slot first. */
export const maxDuration = 300;

/**
 * GET /api/file/[id]/slides
 *
 * One of the signed-in person's uploaded presentations (.pptx, .pptm,
 * .ppsx, .potx, .ppt) as a PDF with one page per slide, hidden slides
 * included, so PDF page n is slide n. The translation setup and review
 * show slides from it as they show a PDF's pages.
 *
 * It goes through the render service's interactive lane: a full queue
 * answers 503 `RENDER_BUSY` with Retry-After, an unreadable or protected
 * deck 422.
 *
 * Responses: 200 `application/pdf`; 400 not a presentation id or too
 * large; 401; 404 no such file for this person.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidFileId(id)) {
    return badRequestResponse('Invalid file identifier', 'INVALID_FILE_ID');
  }
  const extension = nativeUploadExtension(id);
  if (!extension || extension === 'pdf') {
    return badRequestResponse('This file is not a presentation', 'NOT_A_DECK');
  }

  const session: Session | null = await auth();
  if (!session) return unauthorizedResponse();

  // Files are stored under the owner's own prefix, so another person's id
  // resolves to nothing rather than to their file.
  const userId = getUserIdFromSession(session);
  let file: Buffer;
  try {
    file = await (createBlobStorageClient(session).get(
      `${userId}/uploads/files/${id}`,
      BlobProperty.BLOB,
    ) as Promise<Buffer>);
  } catch (error) {
    if (isBlobNotFoundError(error)) return notFoundResponse('File');
    console.error('[file slides] Failed to read file:', error);
    return errorResponse('Failed to retrieve file', 500);
  }
  if (file.byteLength > NATIVE_DECK_MAX_BYTES) {
    return badRequestResponse(
      'This presentation is too large',
      'SLIDES_TOO_LARGE',
    );
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'slides-'));
  try {
    // A fixed name: nothing from the request reaches a path but the
    // validated extension.
    const inputPath = path.join(workDir, `deck.${extension}`);
    await fs.promises.writeFile(inputPath, file);
    const pdfPath = await getRenderService().convert({
      inputPath,
      type: extension,
      convertTo: deckPdfExport(),
      outputDir: path.join(workDir, 'out'),
      lane: 'interactive',
      signal: request.signal,
    });
    const pdf = await fs.promises.readFile(pdfPath);
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        // Ids are content hashes, so the PDF never goes stale; it is kept in
        // the person's own browser cache only.
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    console.error('[file slides] Conversion failed:', error);
    return (
      renderErrorResponse(error) ??
      errorResponse('This presentation could not be laid out', 500)
    );
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
