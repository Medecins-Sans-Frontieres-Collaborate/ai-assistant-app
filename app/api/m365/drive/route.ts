/**
 * OneDrive / drive browsing for the M365 file picker.
 *
 * GET /api/m365/drive?view=children[&driveId=…][&itemId=…][&sort=…][&dir=…]
 * GET /api/m365/drive?view=recent
 * GET /api/m365/drive?view=shared
 * GET /api/m365/drive?view=search&q=…[&driveId=…][&types=ext,ext,…]
 * Any view + &pageToken=… replays a previously issued continuation token.
 *
 * `children` without ids lists the user's OneDrive root; with a driveId only,
 * that drive's root (SharePoint document libraries); with both, a folder.
 * Ordering is strict Graph server order (folders-first regrouping is
 * unreliable/tenant-inconsistent under pagination, so it is not attempted);
 * `sort`/`dir` map to $orderby on the children view only — recent, shared and
 * search accept but ignore them (Graph rejects $orderby there).
 *
 * `types` restricts the search view's parallel filename query with a KQL
 * `filetype:` clause so guaranteed name matches survive the picker's
 * type filter; the content search window is filtered client-side (the
 * `search(q=)` endpoint has no filetype support). Like `sort`/`dir`, it is
 * validated on every view but only meaningful on search — browse listings
 * filter client-side by design, so other views accept and ignore it.
 */
import { NextRequest } from 'next/server';

import {
  mergeSearchResults,
  searchDriveByFilename,
} from '@/lib/services/m365/driveSearch';
import {
  M365DriveEntry,
  M365Error,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
  normalizeDriveItem,
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

import type { M365DriveSort, M365SortDir } from '@/types/m365';

import { auth } from '@/auth';

const SCOPES = ['Files.ReadWrite.All'];
const PAGE_SIZE = 50;
const MIN_SEARCH_LENGTH = 2;
const ITEM_SELECT =
  '$select=id,name,size,webUrl,lastModifiedDateTime,folder,file,parentReference,remoteItem';

const VIEWS = ['children', 'recent', 'shared', 'search'];

// `types` extensions are interpolated into a KQL query — the tight charset
// is a hard requirement, not just hygiene.
const TYPE_EXT_REGEX = /^[a-z0-9]{1,10}$/;
const TYPES_MAX = 20;

const SORT_FIELDS: Record<M365DriveSort, string> = {
  name: 'name',
  lastModified: 'lastModifiedDateTime',
  size: 'size',
};

const DEFAULT_DIRS: Record<M365DriveSort, M365SortDir> = {
  name: 'asc',
  lastModified: 'desc',
  size: 'desc',
};

/**
 * OneDrive for Business/SharePoint tenants reject $orderby on some fields;
 * graphFetch collapses Graph 400s into a generic M365Error, so the rejection
 * is only recognizable by its message.
 */
const ORDERBY_REJECTED_REGEX = /invalid|not.?supported|orderby/i;

interface GraphPage {
  value?: unknown[];
  '@odata.nextLink'?: string;
}

function normalizeEntries(data: GraphPage): M365DriveEntry[] {
  return (data.value ?? [])
    .map((item) => normalizeDriveItem(item as never))
    .filter((entry): entry is M365DriveEntry => entry !== null);
}

/** Encoded continuation token for a Graph page, if it advertises one. */
function pageNextToken(data: GraphPage): string | undefined {
  const nextLink = data['@odata.nextLink'];
  return nextLink ? encodeGraphNextLink(nextLink) : undefined;
}

function pageResponse(entries: M365DriveEntry[], nextToken?: string) {
  return successResponse({ entries, ...(nextToken && { nextToken }) });
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
  const sortParam = params.get('sort');
  const dirParam = params.get('dir');
  const pageToken = params.get('pageToken');
  const typesParam = params.get('types');

  if (!VIEWS.includes(view)) {
    return badRequestResponse('Unknown view');
  }
  if (driveId && !isValidGraphId(driveId)) {
    return badRequestResponse('Invalid driveId');
  }
  if (itemId && !isValidGraphId(itemId)) {
    return badRequestResponse('Invalid itemId');
  }
  if (itemId && !driveId) {
    return badRequestResponse('itemId requires driveId');
  }
  // Object.hasOwn, not `in`: prototype keys like "constructor" must 400.
  if (sortParam && !Object.hasOwn(SORT_FIELDS, sortParam)) {
    return badRequestResponse('Invalid sort');
  }
  if (dirParam && dirParam !== 'asc' && dirParam !== 'desc') {
    return badRequestResponse('Invalid dir');
  }
  let types: string[] | undefined;
  if (typesParam !== null) {
    const parsed = typesParam
      .split(',')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean);
    if (
      parsed.length === 0 ||
      parsed.length > TYPES_MAX ||
      parsed.some((ext) => !TYPE_EXT_REGEX.test(ext))
    ) {
      return badRequestResponse('Invalid types');
    }
    types = parsed;
  }

  try {
    if (pageToken) {
      const nextLink = decodeGraphPageToken(pageToken);
      if (!nextLink) return badRequestResponse('Invalid page token');
      // Replay the baked nextLink verbatim ($skiptoken/$select/$orderby are
      // embedded). Continuation pages keep raw Graph order for every view —
      // re-tiering each search page would reshuffle rows already on screen.
      const data = await graphJson<GraphPage>(req, SCOPES, nextLink);
      return pageResponse(normalizeEntries(data), pageNextToken(data));
    }

    switch (view) {
      case 'children': {
        const sort = (sortParam as M365DriveSort | null) ?? 'name';
        const dir = (dirParam as M365SortDir | null) ?? DEFAULT_DIRS[sort];
        const base = driveId
          ? itemId
            ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`
            : `/drives/${encodeURIComponent(driveId)}/root`
          : '/me/drive/root';
        const unsorted = `${base}/children?$top=${PAGE_SIZE}&${ITEM_SELECT}`;
        let data: GraphPage;
        let sortApplied = true;
        try {
          data = await graphJson<GraphPage>(
            req,
            SCOPES,
            `${unsorted}&$orderby=${SORT_FIELDS[sort]}%20${dir}`,
          );
        } catch (error) {
          if (
            error instanceof M365Error &&
            ORDERBY_REJECTED_REGEX.test(error.message)
          ) {
            // Tenant rejected the $orderby — retry once without it and let
            // the client know the requested order was dropped.
            data = await graphJson<GraphPage>(req, SCOPES, unsorted);
            sortApplied = false;
          } else {
            throw error;
          }
        }
        const nextToken = pageNextToken(data);
        return successResponse({
          entries: normalizeEntries(data),
          ...(nextToken && { nextToken }),
          ...(!sortApplied && { sortApplied: false }),
        });
      }
      case 'recent': {
        const data = await graphJson<GraphPage>(
          req,
          SCOPES,
          `/me/drive/recent?$top=${PAGE_SIZE}`,
        );
        return pageResponse(normalizeEntries(data), pageNextToken(data));
      }
      case 'shared': {
        const data = await graphJson<GraphPage>(
          req,
          SCOPES,
          `/me/drive/sharedWithMe?$top=${PAGE_SIZE}`,
        );
        return pageResponse(normalizeEntries(data), pageNextToken(data));
      }
      default: {
        // search
        if (query.length < MIN_SEARCH_LENGTH) {
          return badRequestResponse('Search query too short');
        }
        const escaped = encodeURIComponent(query.replace(/'/g, "''"));
        const base = driveId
          ? `/drives/${encodeURIComponent(driveId)}/root`
          : '/me/drive/root';
        // Unscoped searches also run the dedicated filename query in
        // parallel — the only way a literal name match is GUARANTEED to
        // surface (content-relevance flooding can push it past any bounded
        // window of search(q=)). Drive-scoped pickers skip it: their
        // corpora are small and /search/query cannot scope to one drive.
        const [nameHits, first] = await Promise.all([
          driveId
            ? Promise.resolve([] as M365DriveEntry[])
            : searchDriveByFilename(req, SCOPES, query, types),
          graphJson<GraphPage>(
            req,
            SCOPES,
            `${base}/search(q='${escaped}')?$top=${PAGE_SIZE}&${ITEM_SELECT}`,
          ),
        ]);
        let window = normalizeEntries(first);
        let lastPage = first;
        const firstNextLink = first['@odata.nextLink'];
        if (firstNextLink) {
          // Widen the re-rank window to two pages (≤100 items, 2 Graph calls
          // max) so exact filename matches buried by relevance still surface.
          const second = await graphJson<GraphPage>(req, SCOPES, firstNextLink);
          window = window.concat(normalizeEntries(second));
          lastPage = second;
        }
        return pageResponse(
          mergeSearchResults(nameHits, window, query),
          pageNextToken(lastPage),
        );
      }
    }
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
