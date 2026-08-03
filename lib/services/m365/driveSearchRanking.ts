/**
 * Pure drive-search ranking — importable from CLIENT code (the picker's
 * instant local matches) and the server route alike. No imports at all:
 * anything Graph-touching lives in driveSearch.ts.
 */
import type { M365DriveEntry } from '@/types/m365';

/** Fuzzy tier only fires on queries long enough to make ≤2 edits meaningful. */
const FUZZY_MIN_QUERY_LENGTH = 4;

// ---------------------------------------------------------------------------
// Tiered ranking (exported for tests; pure)
// ---------------------------------------------------------------------------

/** Filename tokens: "geo_report-v2.pptx" → ['geo','report','v2','pptx']. */
function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s\-_.()[\]]+/)
    .filter(Boolean);
}

// Third small copy in the repo (mailScreen keeps one privately) — a shared
// util would couple unrelated module graphs for ~15 lines.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/**
 * Lower is better. 0 exact name · 1 exact stem · 2 all query tokens are
 * prefixes of name tokens ("geo report" → geo_report_v2.pptx) · 3 whole
 * query is a substring · 4 fuzzy stem (≤2 edits, query ≥4 chars) ·
 * 5 content-only.
 */
export function nameMatchTier(name: string, query: string): number {
  const q = query.toLowerCase().trim();
  const lower = name.toLowerCase();
  const stem = lower.replace(/\.[^.]*$/, '');
  if (lower === q) return 0;
  if (stem === q) return 1;
  const queryTokens = tokensOf(q);
  const nameTokens = tokensOf(lower);
  if (
    queryTokens.length > 0 &&
    queryTokens.every((qt) => nameTokens.some((nt) => nt.startsWith(qt)))
  ) {
    return 2;
  }
  if (lower.includes(q)) return 3;
  if (q.length >= FUZZY_MIN_QUERY_LENGTH && levenshtein(stem, q) <= 2) {
    return 4;
  }
  return 5;
}

export function isNameMatch(name: string, query: string): boolean {
  return nameMatchTier(name, query) < 5;
}

/**
 * Tier-then-recency ordering, and tags every entry with its match kind for
 * the picker's sectioned rendering.
 */
export function rankSearchEntries(
  entries: M365DriveEntry[],
  query: string,
): M365DriveEntry[] {
  const tagged = entries.map((entry) => {
    const tier = nameMatchTier(entry.name, query);
    return {
      entry: {
        ...entry,
        match: (tier < 5 ? 'name' : 'content') as 'name' | 'content',
      },
      tier,
    };
  });
  return tagged
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aTime = a.entry.lastModified ?? '';
      const bTime = b.entry.lastModified ?? '';
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return a.index - b.index;
    })
    .map((item) => item.entry);
}

/** Merge with the filename-query hits FIRST; dedupe by driveId/itemId. */
export function mergeSearchResults(
  nameHits: M365DriveEntry[],
  contentWindow: M365DriveEntry[],
  query: string,
): M365DriveEntry[] {
  const seen = new Set<string>();
  const merged: M365DriveEntry[] = [];
  for (const entry of [...nameHits, ...contentWindow]) {
    const key = `${entry.driveId}/${entry.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return rankSearchEntries(merged, query);
}
