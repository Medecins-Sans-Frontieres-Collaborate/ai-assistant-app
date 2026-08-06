/**
 * SharePoint site discovery for the M365 file picker.
 *
 * GET /api/m365/sites?q=…        → sites matching the search (user-permission
 *                                  trimmed by Graph); &pageToken=… replays a
 *                                  previously issued continuation token
 * GET /api/m365/sites?siteId=…   → that site's document libraries (drives),
 *                                  browsable via /api/m365/drive?driveId=…
 */
import { NextRequest } from 'next/server';

import {
  M365DriveInfo,
  M365SiteEntry,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';
import {
  decodeGraphPageToken,
  encodeGraphNextLink,
} from '@/lib/services/m365/graphPageToken';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Sites.Read.All'];

// A site's document libraries are a short list; follow Graph paging to
// exhaustion server-side (the cap is a runaway guard, not a UX limit).
const MAX_DRIVE_PAGES = 20;

// Site ids are comma-composed (host,siteCollectionId,webId) — allow commas.
function isValidSiteId(id: string): boolean {
  return /^[A-Za-z0-9.,_-]{1,512}$/.test(id);
}

interface GraphSitePage {
  value?: {
    id?: string;
    displayName?: string;
    name?: string;
    webUrl?: string;
  }[];
  '@odata.nextLink'?: string;
}

function normalizeSites(data: GraphSitePage): M365SiteEntry[] {
  return (data.value ?? [])
    .filter((s) => !!s.id)
    .map((s) => ({
      siteId: s.id as string,
      name: s.displayName || s.name || 'SharePoint site',
      ...(s.webUrl && { webUrl: s.webUrl }),
    }));
}

function sitesResponse(data: GraphSitePage) {
  const nextLink = data['@odata.nextLink'];
  const nextToken = nextLink ? encodeGraphNextLink(nextLink) : undefined;
  return successResponse({
    sites: normalizeSites(data),
    ...(nextToken && { nextToken }),
  });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const query = params.get('q')?.trim() ?? '';
  const siteId = params.get('siteId');
  const pageToken = params.get('pageToken');

  try {
    if (siteId) {
      if (!isValidSiteId(siteId)) {
        return badRequestResponse('Invalid siteId');
      }
      // Follow drive paging server-side — a truncated library list with no
      // signal would silently hide destinations from the picker.
      const drives: M365DriveInfo[] = [];
      let path: string | null =
        `/sites/${encodeURIComponent(siteId)}/drives?$select=id,name`;
      for (let page = 0; path && page < MAX_DRIVE_PAGES; page++) {
        const data: {
          value?: { id?: string; name?: string }[];
          '@odata.nextLink'?: string;
        } = await graphJson(req, SCOPES, path);
        for (const d of data.value ?? []) {
          if (isValidGraphId(d.id)) {
            drives.push({ driveId: d.id, name: d.name ?? 'Documents' });
          }
        }
        path = data['@odata.nextLink'] ?? null;
      }
      return successResponse({ drives });
    }

    if (pageToken) {
      const nextLink = decodeGraphPageToken(pageToken);
      if (!nextLink) return badRequestResponse('Invalid page token');
      const data = await graphJson<GraphSitePage>(req, SCOPES, nextLink);
      return sitesResponse(data);
    }

    if (!query) {
      return badRequestResponse('Missing search query');
    }
    const data = await graphJson<GraphSitePage>(
      req,
      SCOPES,
      `/sites?search=${encodeURIComponent(query)}&$select=id,displayName,name,webUrl&$top=25`,
    );
    return sitesResponse(data);
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
