/**
 * Entra group search + name resolution for the admin group pickers.
 *
 * GET  /api/m365/groups?q=…    → groups whose displayName starts with the query
 * GET  /api/m365/groups?ids=…  → display names for ≤50 stored object ids (legacy
 *      comma list; kept for old clients)
 * POST /api/m365/groups {ids}  → display names for ≤500 stored object ids in
 *      one call — the editors and list views resolve names on open, so names
 *      are always fetched fresh and never trusted from storage.
 *
 * Delegated Graph (Group.Read.All). Serves object id + display name only —
 * the access-rule and limit-override schemas persist bare object ids, so
 * this is a name-resolution convenience, never an authorization surface.
 * Resolution is one `directoryObjects/getByIds` per ≤1000 ids behind a
 * per-replica name cache (lib/services/m365/groupDirectory.ts), not one GET
 * per id.
 */
import { NextRequest } from 'next/server';

import { graphJson, m365ErrorResponse } from '@/lib/services/m365/graphApi';
import {
  GROUP_SCOPES,
  fetchGroupNames,
} from '@/lib/services/m365/groupDirectory';
import { isEntraGroupId } from '@/lib/services/shared/principalMatching';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const MIN_QUERY_LENGTH = 2;
const MAX_ID_LOOKUPS_GET = 50;
const MAX_ID_LOOKUPS_POST = 500;

async function resolveNames(req: NextRequest, ids: string[]) {
  const names = await fetchGroupNames(req, ids);
  const groups = ids
    .filter((id) => names.has(id))
    .map((id) => ({ id, name: names.get(id) as string }));
  return successResponse({ groups });
}

function parseIds(raw: unknown, max: number): string[] | null {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const ids = [
    ...new Set(
      list
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0 || ids.length > max) return null;
  if (!ids.every((id) => isEntraGroupId(id))) return null;
  return ids;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const ids = parseIds(
    (body as { ids?: unknown } | null)?.ids,
    MAX_ID_LOOKUPS_POST,
  );
  if (!ids) {
    return badRequestResponse(
      `ids must list 1-${MAX_ID_LOOKUPS_POST} Entra group object ids`,
    );
  }
  try {
    return await resolveNames(req, ids);
  } catch (error) {
    return m365ErrorResponse(error);
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const rawIds = req.nextUrl.searchParams.get('ids');
  if (rawIds !== null) {
    const ids = parseIds(rawIds, MAX_ID_LOOKUPS_GET);
    if (!ids) {
      return badRequestResponse(
        `ids must list 1-${MAX_ID_LOOKUPS_GET} Entra group object ids`,
      );
    }
    try {
      return await resolveNames(req, ids);
    } catch (error) {
      return m365ErrorResponse(error);
    }
  }

  const query = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (query.length < MIN_QUERY_LENGTH) {
    return badRequestResponse('Search query too short');
  }

  try {
    // OData string literal: single quotes are escaped by doubling BEFORE
    // URI-encoding, or a quote in the query breaks out of the literal.
    const escaped = encodeURIComponent(query.replace(/'/g, "''"));
    const data = await graphJson<{
      value?: { id?: string; displayName?: string }[];
    }>(
      req,
      GROUP_SCOPES,
      `/groups?$filter=startswith(displayName,'${escaped}')&$select=id,displayName&$top=20`,
    );
    const groups = (data.value ?? [])
      .filter((g): g is { id: string; displayName?: string } => !!g.id)
      .map((g) => ({ id: g.id, name: g.displayName || g.id }));
    return successResponse({ groups });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
