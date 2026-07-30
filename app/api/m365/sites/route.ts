/**
 * SharePoint site discovery for the M365 file picker.
 *
 * GET /api/m365/sites?q=…        → sites matching the search (user-permission
 *                                  trimmed by Graph)
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
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Sites.Read.All'];

// Site ids are comma-composed (host,siteCollectionId,webId) — allow commas.
function isValidSiteId(id: string): boolean {
  return /^[A-Za-z0-9.,_-]{1,512}$/.test(id);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const query = params.get('q')?.trim() ?? '';
  const siteId = params.get('siteId');

  try {
    if (siteId) {
      if (!isValidSiteId(siteId)) {
        return badRequestResponse('Invalid siteId');
      }
      const data = await graphJson<{
        value?: { id?: string; name?: string }[];
      }>(
        req,
        SCOPES,
        `/sites/${encodeURIComponent(siteId)}/drives?$select=id,name`,
      );
      const drives: M365DriveInfo[] = (data.value ?? [])
        .filter((d) => isValidGraphId(d.id))
        .map((d) => ({ driveId: d.id as string, name: d.name ?? 'Documents' }));
      return successResponse({ drives });
    }

    if (!query) {
      return badRequestResponse('Missing search query');
    }
    const data = await graphJson<{
      value?: {
        id?: string;
        displayName?: string;
        name?: string;
        webUrl?: string;
      }[];
    }>(
      req,
      SCOPES,
      `/sites?search=${encodeURIComponent(query)}&$select=id,displayName,name,webUrl&$top=25`,
    );
    const sites: M365SiteEntry[] = (data.value ?? [])
      .filter((s) => !!s.id)
      .map((s) => ({
        siteId: s.id as string,
        name: s.displayName || s.name || 'SharePoint site',
        ...(s.webUrl && { webUrl: s.webUrl }),
      }));
    return successResponse({ sites });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
