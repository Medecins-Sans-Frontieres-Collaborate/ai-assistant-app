/**
 * Drive-search ranking + the dedicated filename query.
 *
 * The structural problem this solves: Graph's drive `search(q=)` scores
 * filename and CONTENT matches on one opaque relevance scale, so in a big
 * drive a literal filename match can sit past any bounded window of
 * content matches — no post-hoc re-ranking can promote what never entered
 * the window. The fix is a parallel Microsoft Search API query
 * (`filename:{q}*` KQL, driveItem entity) that can ONLY return name
 * matches; its hits are merged in front of the content search, making
 * "the file is literally named that" a guarantee instead of a probability.
 *
 * Ranking within the merged window is tiered by name-match quality, with
 * RECENCY (lastModified desc) as the within-tier order — Graph's opaque
 * relevance is what made content matches feel random.
 */
import { NextRequest } from 'next/server';

import { isNameMatch } from '@/lib/services/m365/driveSearchRanking';
import { graphJson, normalizeDriveItem } from '@/lib/services/m365/graphApi';

import { fileExtension } from '@/lib/utils/app/m365FileTypes';

import type { M365DriveEntry } from '@/types/m365';

export {
  isNameMatch,
  mergeSearchResults,
  nameMatchTier,
  rankSearchEntries,
} from '@/lib/services/m365/driveSearchRanking';

const FILENAME_QUERY_SIZE = 25;

// ---------------------------------------------------------------------------
// Filename query (Microsoft Search API)
// ---------------------------------------------------------------------------

interface SearchHit {
  resource?: {
    id?: string;
    name?: string;
    size?: number;
    webUrl?: string;
    lastModifiedDateTime?: string;
    file?: { mimeType?: string };
    folder?: { childCount?: number };
    parentReference?: { driveId?: string; path?: string };
  };
}

interface SearchQueryResponse {
  value?: {
    hitsContainers?: { hits?: SearchHit[] }[];
  }[];
}

/**
 * KQL term hygiene: strip quotes plus the structural characters that would
 * change query semantics — parentheses regroup, colons start a property
 * restriction (`x) OR (filetype:one`), comparison/brace characters bind
 * ranges. Uppercase operator WORDS (AND/OR/NOT) between plain terms only
 * shape relevance, never reach beyond the user's own delegated permissions.
 */
function kqlTerm(query: string): string {
  return query
    .replace(/["'():={}[\]<>*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Filename-only search across the user's reachable drives. Best-effort by
 * design: any failure returns [] so the content search still answers —
 * the caller must never let this path block results. Only used for
 * unscoped (whole-OneDrive) searches; drive-scoped pickers keep the plain
 * search, whose smaller corpus doesn't have the flooding problem.
 */
export async function searchDriveByFilename(
  req: NextRequest,
  scopes: string[],
  query: string,
  typeExtensions?: readonly string[],
): Promise<M365DriveEntry[]> {
  const term = kqlTerm(query);
  if (!term) return [];
  // Type-filtered searches restrict the filename query itself — without
  // this, none of the 25 guaranteed name matches may survive the client's
  // extension filter even though matching files of that type exist.
  // Extensions are route-validated ([a-z0-9]+), so they are KQL-safe.
  const filetypeClause = typeExtensions?.length
    ? ` AND (${typeExtensions.map((ext) => `filetype:${ext}`).join(' OR ')})`
    : '';
  try {
    const data = await graphJson<SearchQueryResponse>(
      req,
      scopes,
      '/search/query',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [
            {
              entityTypes: ['driveItem'],
              query: { queryString: `filename:${term}*${filetypeClause}` },
              size: FILENAME_QUERY_SIZE,
            },
          ],
        }),
      },
    );
    const hits = data.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    return (
      hits
        .map((hit) => normalizeDriveItem(hit.resource as never))
        .filter((entry): entry is M365DriveEntry => entry !== null)
        // The index can lag or fuzz — keep only entries our own tiering
        // agrees are name matches, so the "Name matches" section stays honest.
        .filter((entry) => isNameMatch(entry.name, query))
        // Same defensive stance for the filetype restriction.
        .filter(
          (entry) =>
            !typeExtensions?.length ||
            typeExtensions.includes(fileExtension(entry.name)),
        )
    );
  } catch {
    return [];
  }
}
