/**
 * OneDrive / drive browsing for the M365 file picker.
 *
 * GET /api/m365/drive?view=children[&driveId=…][&itemId=…]
 * GET /api/m365/drive?view=recent
 * GET /api/m365/drive?view=shared
 * GET /api/m365/drive?view=search&q=…[&driveId=…]
 *
 * `children` without ids lists the user's OneDrive root; with a driveId only,
 * that drive's root (SharePoint document libraries); with both, a folder.
 * All results are normalized M365DriveEntry[] — folders first, then by name.
 */
import { NextRequest } from 'next/server';

import {
  M365DriveEntry,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
  normalizeDriveItem,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Files.ReadWrite.All'];
const PAGE_SIZE = 50;
const ITEM_SELECT =
  '$select=id,name,size,webUrl,lastModifiedDateTime,folder,file,parentReference,remoteItem';

function sortEntries(entries: M365DriveEntry[]): M365DriveEntry[] {
  return entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const view = params.get('view') ?? 'children';
  const driveId = params.get('driveId');
  const itemId = params.get('itemId');
  const query = params.get('q')?.trim() ?? '';

  if (driveId && !isValidGraphId(driveId)) {
    return badRequestResponse('Invalid driveId');
  }
  if (itemId && !isValidGraphId(itemId)) {
    return badRequestResponse('Invalid itemId');
  }
  if (itemId && !driveId) {
    return badRequestResponse('itemId requires driveId');
  }

  let path: string;
  switch (view) {
    case 'children': {
      const base = driveId
        ? itemId
          ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`
          : `/drives/${encodeURIComponent(driveId)}/root`
        : '/me/drive/root';
      path = `${base}/children?$top=${PAGE_SIZE}&${ITEM_SELECT}&$orderby=name`;
      break;
    }
    case 'recent':
      path = `/me/drive/recent?$top=${PAGE_SIZE}`;
      break;
    case 'shared':
      path = `/me/drive/sharedWithMe?$top=${PAGE_SIZE}`;
      break;
    case 'search': {
      if (!query) return badRequestResponse('Missing search query');
      const escaped = encodeURIComponent(query.replace(/'/g, "''"));
      const base = driveId
        ? `/drives/${encodeURIComponent(driveId)}/root`
        : '/me/drive/root';
      path = `${base}/search(q='${escaped}')?$top=${PAGE_SIZE}&${ITEM_SELECT}`;
      break;
    }
    default:
      return badRequestResponse('Unknown view');
  }

  try {
    const data = await graphJson<{ value?: unknown[] }>(req, SCOPES, path);
    const entries = (data.value ?? [])
      .map((item) => normalizeDriveItem(item as never))
      .filter((entry): entry is M365DriveEntry => entry !== null);
    // Recent/shared come back relevance/time ordered — keep Graph's order.
    return successResponse({
      entries: view === 'children' ? sortEntries(entries) : entries,
    });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
