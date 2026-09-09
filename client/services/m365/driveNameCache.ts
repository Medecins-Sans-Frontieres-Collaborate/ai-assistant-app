/**
 * Session-scoped name index of drive entries the user has already seen
 * (recent files, browsed folders, prior search results). Serves INSTANT
 * local matches while a server search is in flight — the "file I touched
 * this week" case answers at zero latency even when Graph search indexing
 * lags or floods, and doubles as the safety net for just-created files the
 * Search API hasn't indexed yet.
 *
 * Module-level on purpose: the picker body remounts per opening, and the
 * whole point is remembering across openings within the session. Bounded;
 * never persisted.
 */
import {
  isNameMatch,
  rankSearchEntries,
} from '@/lib/services/m365/driveSearchRanking';

import type { M365DriveEntry } from '@/types/m365';

const MAX_ENTRIES = 500;

const cache = new Map<string, M365DriveEntry>();

export function recordDriveEntries(entries: M365DriveEntry[]): void {
  for (const entry of entries) {
    if (entry.isFolder) continue;
    const key = `${entry.driveId}/${entry.itemId}`;
    // Re-insert to refresh LRU position.
    cache.delete(key);
    // Strip search-time tagging — the cache stores neutral entries.
    const { match: _match, ...neutral } = entry;
    cache.set(key, neutral);
    if (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
}

/** Name-matching cached entries, best first, capped. */
export function queryDriveNameCache(
  query: string,
  limit = 5,
): M365DriveEntry[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const hits = Array.from(cache.values()).filter((entry) =>
    isNameMatch(entry.name, q),
  );
  return rankSearchEntries(hits, q).slice(0, limit);
}

/** Test hook. */
export function clearDriveNameCache(): void {
  cache.clear();
}
