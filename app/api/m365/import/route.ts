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
 * the pipeline it feeds is not built for more.
 */
import { NextRequest, NextResponse } from 'next/server';

import {
  M365Error,
  graphFetch,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

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

const SCOPES = ['Files.ReadWrite.All'];

interface GraphItemMeta {
  name?: string;
  size?: number;
  webUrl?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  '@microsoft.graph.downloadUrl'?: string;
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
    const meta = await graphJson<GraphItemMeta>(
      req,
      SCOPES,
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}` +
        '?$select=name,size,webUrl,folder,file,@microsoft.graph.downloadUrl',
    );

    if (meta.folder) {
      return badRequestResponse('Folders cannot be imported');
    }
    const name = meta.name ?? 'file';
    const mimeType = meta.file?.mimeType || 'application/octet-stream';
    const category = getFileCategory(name, mimeType);
    const limit = getFileSizeLimit(category);
    if ((meta.size ?? 0) > limit) {
      return badRequestResponse(
        `File exceeds the ${getFileSizeLimitDisplay(category)} limit for ${category} files`,
        'M365_FILE_TOO_LARGE',
      );
    }

    // The downloadUrl is pre-authenticated and short-lived; fall back to the
    // /content endpoint (a Graph 302 fetch follows the redirect) without it.
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    const content = downloadUrl
      ? await fetch(downloadUrl)
      : await graphFetch(
          req,
          SCOPES,
          `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
        );
    if (!content.ok || !content.body) {
      throw new M365Error(
        'Failed to download file content',
        'graph_error',
        502,
      );
    }

    return new NextResponse(content.body, {
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
    return m365ErrorResponse(error);
  }
}
