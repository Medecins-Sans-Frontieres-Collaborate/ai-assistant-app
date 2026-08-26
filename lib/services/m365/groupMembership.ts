/**
 * Entra group membership for principal targeting (third pass §5).
 *
 * `resolveUserGroupIds` fetches the signed-in user's transitive group ids
 * via delegated Graph (`POST /me/getMemberGroups`, Group.Read.All) and
 * caches them in-process, keyed by BOTH user id and mail — the limits
 * principal builder looks up by id, the agent-access rule evaluator only
 * has the user's mail. Both read the cache synchronously so the evaluation
 * hot paths stay sync; routes warm it with one awaited call per request
 * (which is a no-op while the TTL holds).
 *
 * Failure posture: group lookups NEVER throw and NEVER block user/domain
 * matching — on any failure (consent missing, Graph down) the user simply
 * has no groups for the TTL of a short negative-cache entry, exactly the
 * pre-§5 behavior where group targets granted nothing. Group-scoped limits
 * are correspondingly fail-open for at most one cold request per replica;
 * documented trade-off, matching the client-only LD gating posture.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { normalizeMail } from '@/lib/services/shared/principalMatching';

const SCOPES = ['Group.Read.All'];

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
  groupIds: string[];
  expiresAt: number;
}

const cacheById = new Map<string, CacheEntry>();
const cacheByMail = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

/**
 * "View as" group overrides (lib/services/admin/viewAsTypes.ts), kept in
 * their OWN maps so a test session never pollutes the real membership
 * cache. Written by `resolveUserGroupIds` on every request that carries an
 * active override (short TTL, refreshed while the test session lasts) and
 * dropped by the first request without one, so exiting view-as takes
 * effect immediately on the replica that serves it and within
 * VIEW_AS_GROUPS_TTL_MS on any other.
 */
const VIEW_AS_GROUPS_TTL_MS = 2 * 60 * 1000;
const viewAsById = new Map<string, CacheEntry>();
const viewAsByMail = new Map<string, CacheEntry>();

function readViewAsOverride(
  map: Map<string, CacheEntry>,
  key: string,
): string[] | null {
  return readCache(map, key);
}

function writeViewAsOverride(
  userId: string,
  mail: string | undefined,
  groupIds: string[],
): void {
  const entry: CacheEntry = {
    groupIds,
    expiresAt: Date.now() + VIEW_AS_GROUPS_TTL_MS,
  };
  viewAsById.set(userId, entry);
  if (mail) viewAsByMail.set(mail, entry);
}

function clearViewAsOverride(userId: string, mail: string | undefined): void {
  viewAsById.delete(userId);
  if (mail) viewAsByMail.delete(mail);
}

function readCache(map: Map<string, CacheEntry>, key: string): string[] | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.groupIds;
}

function writeCache(
  userId: string,
  mail: string | undefined,
  groupIds: string[],
  ttl: number,
): void {
  // Oldest-first eviction keeps the maps bounded on busy multi-user replicas.
  for (const map of [cacheById, cacheByMail]) {
    if (map.size >= MAX_CACHE_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  const entry: CacheEntry = { groupIds, expiresAt: Date.now() + ttl };
  cacheById.set(userId, entry);
  if (mail) cacheByMail.set(mail, entry);
}

/** Sync cache read for the limits principal builder. [] when cold. */
export function getCachedGroupIdsForUser(userId: string): string[] {
  return (
    readViewAsOverride(viewAsById, userId) ?? readCache(cacheById, userId) ?? []
  );
}

/** Sync cache read for the agent-access evaluator. [] when cold. */
export function getCachedGroupIdsForMail(
  mail: string | null | undefined,
): string[] {
  const normalized = normalizeMail(mail);
  if (!normalized) return [];
  return (
    readViewAsOverride(viewAsByMail, normalized) ??
    readCache(cacheByMail, normalized) ??
    []
  );
}

/**
 * Warms (and returns) the user's transitive group ids. Safe to await on any
 * request path: cached hits return synchronously, concurrent cold calls
 * share one Graph request, failures resolve to [].
 */
export async function resolveUserGroupIds(
  req: NextRequest,
  session: Session | null,
): Promise<string[]> {
  const userId = session?.user?.id;
  if (!userId) return [];
  const mail = normalizeMail(session?.user?.mail);

  // View-as (admin test mode) replaces membership for this session only.
  // The session callback already verified the real identity is a global
  // admin before attaching `viewAs`, so this is trusted input here.
  const viewAsGroups = session?.user?.viewAs?.overrides.groupIds;
  if (viewAsGroups) {
    writeViewAsOverride(userId, mail, viewAsGroups);
    return viewAsGroups;
  }
  clearViewAsOverride(userId, mail);

  const cached = readCache(cacheById, userId);
  if (cached !== null) return cached;

  const running = inFlight.get(userId);
  if (running) return running;
  const fetchPromise = (async () => {
    try {
      // Lazy import: this module is reached from the sync principal-building
      // paths (limits routeGuard, agent access), which are imported by half
      // the server. A static graphApi import would drag next-auth into
      // every one of those module graphs (and their tests) for a call that
      // only happens here.
      const { graphJson } = await import('@/lib/services/m365/graphApi');
      const data = await graphJson<{ value?: unknown[] }>(
        req,
        SCOPES,
        '/me/getMemberGroups',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ securityEnabledOnly: false }),
        },
      );
      const groupIds = (data.value ?? []).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
      writeCache(userId, mail, groupIds, CACHE_TTL_MS);
      return groupIds;
    } catch (error) {
      // Degraded evaluation (fourth pass A1): group clauses will evaluate
      // false for this user until the negative cache expires, while
      // user/domain clauses keep working. Audit it — a quiet Graph outage
      // must not look like a correct deny.
      console.warn(
        `[agent-access-audit] group-membership degraded user=${userId} ` +
          `reason=${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      );
      // Negative-cache briefly so a consent gap doesn't hammer Graph.
      writeCache(userId, mail, [], FAILURE_TTL_MS);
      return [];
    } finally {
      inFlight.delete(userId);
    }
  })();
  inFlight.set(userId, fetchPromise);
  return fetchPromise;
}

/** Test hook — evaluation semantics depend on cache state. */
export function clearGroupMembershipCache(): void {
  cacheById.clear();
  cacheByMail.clear();
  inFlight.clear();
  viewAsById.clear();
  viewAsByMail.clear();
}
