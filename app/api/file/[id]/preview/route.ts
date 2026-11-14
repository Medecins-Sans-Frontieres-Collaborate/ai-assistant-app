import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { isValidFileId } from '@/lib/utils/server/file/fileId';
import { renderFilePagePreview } from '@/lib/utils/server/file/filePreview';

import { auth } from '@/auth';
import {
  FilePagePreview,
  PAGE_PREVIEW_MAX_BYTES,
  fileExtension,
  isPagePreviewable,
} from '@/lib/constants/filePreview';

/** Conversion can take a while for a large deck; allow for it. */
export const maxDuration = 120;

/**
 * GET /api/file/[id]/preview
 *
 * Renders the first pages of one of the signed-in user's stored documents
 * (Word, PowerPoint, Excel, PDF and their OpenDocument equivalents) as PNG
 * images, so a file can be looked at before it is downloaded.
 *
 * Responses:
 * - 200 `{ success, data: { pages, totalPages } }`
 * - 400 invalid id, a format with no page preview, or a file too large
 * - 401 not signed in
 * - 404 no such file for this user
 * - 500 the document could not be converted
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidFileId(id)) {
    return badRequestResponse('Invalid file identifier', 'INVALID_FILE_ID');
  }
  if (!isPagePreviewable(id)) {
    return badRequestResponse(
      'This file type has no page preview',
      'PREVIEW_UNSUPPORTED',
    );
  }

  const session: Session | null = await auth();
  if (!session) return unauthorizedResponse();

  // Files are stored under the owner's own prefix, so another user's id
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
    console.error('[file preview] Failed to read file:', error);
    return errorResponse('Failed to retrieve file', 500);
  }

  if (file.byteLength > PAGE_PREVIEW_MAX_BYTES) {
    return badRequestResponse(
      'This file is too large to preview',
      'PREVIEW_TOO_LARGE',
    );
  }

  try {
    const preview: FilePagePreview = await renderFilePagePreview(
      file,
      fileExtension(id),
      { signal: request.signal },
    );
    const response = successResponse(preview);
    // Ids are content hashes, so a rendered preview never goes stale; keep
    // it in the user's own browser cache only.
    response.headers.set('Cache-Control', 'private, max-age=3600');
    return response;
  } catch (error) {
    console.error('[file preview] Conversion failed:', error);
    return errorResponse('This file could not be previewed', 500);
  }
}
