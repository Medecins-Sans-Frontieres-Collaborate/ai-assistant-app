/**
 * M365 file import proxy.
 *
 * GET /api/m365/import?driveId=…&itemId=…
 *
 * Downloads a picked OneDrive/SharePoint file with the signed-in user's own
 * delegated token and streams the bytes back. The client wraps them in a
 * File and pushes it through the normal upload pipeline, so everything
 * downstream (validation, extraction, transcription routing, previews)
 * treats an M365 import exactly like a local pick.
 *
 * Size is enforced against the same per-category caps as a local upload —
 * first against Graph metadata, then against the actual bytes as they
 * stream (metadata can be absent or stale). Metadata resolution and content
 * download are the import service's — this route only adds the proxying.
 */
import { NextRequest, NextResponse } from 'next/server';

import { M365Error, isValidGraphId } from '@/lib/services/m365/graphApi';
import {
  M365ImportError,
  fetchDriveItemMeta,
  m365ImportErrorResponse,
  openContentStream,
} from '@/lib/services/m365/m365ImportService';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import {
  getFileCategory,
  getFileSizeLimit,
  getFileSizeLimitDisplay,
} from '@/lib/constants/fileLimits';

export const maxDuration = 120;

/**
 * Passes bytes through while enforcing the cap on what ACTUALLY flows —
 * a body larger than its metadata claimed errors the stream mid-flight
 * instead of proxying without bound.
 */
function cappedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(
            new Error('File exceeded the size limit while streaming'),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const driveId = params.get('driveId');
  const itemId = params.get('itemId');
  if (!isValidGraphId(driveId) || !isValidGraphId(itemId)) {
    return badRequestResponse('Invalid driveId or itemId');
  }

  try {
    const target = { driveId, itemId };
    const meta = await fetchDriveItemMeta(req, target);

    if (meta.folder) {
      throw new M365ImportError('Folders cannot be imported', 'M365_IS_FOLDER');
    }
    const name = meta.name ?? 'file';
    const mimeType = meta.file?.mimeType || 'application/octet-stream';
    const category = getFileCategory(name, mimeType);
    const limit = getFileSizeLimit(category);
    if ((meta.size ?? 0) > limit) {
      throw new M365ImportError(
        `File exceeds the ${getFileSizeLimitDisplay(category)} limit for ${category} files`,
        'M365_FILE_TOO_LARGE',
      );
    }

    const content = await openContentStream(req, target, meta);
    if (!content.body) {
      throw new M365Error(
        'Failed to download file content',
        'graph_error',
        502,
      );
    }

    return new NextResponse(cappedBody(content.body, limit), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'no-store',
        // Metadata the client needs to build the File + tag the tile.
        'X-M365-Name': encodeURIComponent(name),
        ...(meta.webUrl && {
          'X-M365-Web-Url': encodeURIComponent(meta.webUrl),
        }),
      },
    });
  } catch (error) {
    return m365ImportErrorResponse(error);
  }
}
