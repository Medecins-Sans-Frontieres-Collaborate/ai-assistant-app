/**
 * Entra group search for the admin group pickers (third pass §5).
 *
 * GET /api/m365/groups?q=…   → groups whose displayName starts with the query
 * GET /api/m365/groups?ids=… → display names for stored object ids (comma
 *     list, ≤50) — the editors resolve names on open, which answers the
 *     fourth pass's display-name-drift question: names are always fetched
 *     fresh, never persisted.
 *
 * Delegated Graph (Group.Read.All). Serves object id + display name only
 * — the access-rule and limit-override schemas persist bare object ids, so
 * this is a name-resolution convenience, never an authorization surface.
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

const SCOPES = ['Group.Read.All'];

const MIN_QUERY_LENGTH = 2;
const MAX_ID_LOOKUPS = 50;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const rawIds = req.nextUrl.searchParams.get('ids');
  if (rawIds !== null) {
    const ids = rawIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0 || ids.length > MAX_ID_LOOKUPS) {
      return badRequestResponse('ids must list 1-50 group ids');
    }
    if (!ids.every((id) => isValidGraphId(id))) {
      return badRequestResponse('Invalid group id');
    }
    // Per-id fetches: the `id in (…)` filter needs advanced-query headers
    // that not every tenant honors; unknown/deleted ids resolve to nothing
    // rather than failing the batch.
    const results = await Promise.allSettled(
      ids.map((id) =>
        graphJson<{ id?: string; displayName?: string }>(
          req,
          SCOPES,
          `/groups/${encodeURIComponent(id)}?$select=id,displayName`,
        ),
      ),
    );
    const groups = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<{ id?: string; displayName?: string }> =>
          r.status === 'fulfilled' && !!r.value.id,
      )
      .map((r) => ({
        id: r.value.id as string,
        name: r.value.displayName || (r.value.id as string),
      }));
    return successResponse({ groups });
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
      SCOPES,
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
