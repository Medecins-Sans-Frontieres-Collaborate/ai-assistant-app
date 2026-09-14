/**
 * Resolve a drive's root folder to a real drive item.
 *
 * GET /api/m365/drive/root?driveId=…  → { itemId, name, webUrl, childCount }
 *
 * The file picker lets an M365-agent admin add a whole SharePoint document
 * library or a team's Files as one folder source. Graph addresses those as
 * `/drives/{id}/root`, but agent sources are stored and enumerated by item
 * id (planner `/items/{id}/delta`, layer-2 probes `/items/{id}`), so the
 * alias is resolved here once, on pick, and the source carries the real id
 * like any other folder.
 */
import { NextRequest } from 'next/server';

import {
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Files.ReadWrite.All'];

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const driveId = req.nextUrl.searchParams.get('driveId');
  if (!isValidGraphId(driveId)) {
    return badRequestResponse('Invalid driveId');
  }

  try {
    const root = await graphJson<{
      id?: string;
      name?: string;
      webUrl?: string;
      folder?: { childCount?: number };
    }>(
      req,
      SCOPES,
      `/drives/${encodeURIComponent(driveId)}/root?$select=id,name,webUrl,folder`,
    );
    if (!root.id) {
      return badRequestResponse('Drive root not found', 'M365_NOT_FOUND');
    }
    return successResponse({
      itemId: root.id,
      name: root.name || 'Documents',
      ...(root.webUrl && { webUrl: root.webUrl }),
      ...(root.folder?.childCount !== undefined && {
        childCount: root.folder.childCount,
      }),
    });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
