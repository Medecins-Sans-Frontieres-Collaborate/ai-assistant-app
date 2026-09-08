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
 *
 * That "no groups" answer is indistinguishable from "genuinely a member of
 * nothing", which for AGENT ACCESS silently fails CLOSED: a group-scoped
 * rule denies, and because /api/agents is fetched once per page load, one
 * degraded request hides the agent for the user's whole session while
 * looking exactly like a correct permission denial. Failed lookups are
 * therefore MARKED (`degraded` on the cache entry) and exposed through
 * `isGroupMembershipDegraded` / `…ForUser`, so the agent-access evaluator
 * can answer 'unavailable' (pass through at discovery, still fail closed at
 * invocation) instead of 'deny'. Usage limits keep reading the plain [] and
 * stay fail-open.
 *
 * Only RETRYABLE failures are marked, though. The negative-cache entry is
 * re-armed identically every time it expires, so the marker tracks the
 * condition, not a 60-second window: a structural failure (tenant consent
 * never granted, a refresh token that no longer redeems) would soften every
 * group-scoped rule for as long as it lasts, listing restricted agents'
 * metadata to the whole tenant indefinitely. Those keep the plain [] and the
 * hard deny that predates the marker; throttling, Graph 5xx and network
 * faults — the genuinely transient cases the softening exists for — mark.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import type { M365ErrorKind } from '@/lib/services/m365/graphApi';
import { normalizeMail } from '@/lib/services/shared/principalMatching';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const SCOPES = ['Group.Read.All'];

/**
 * Graph failure kinds a later attempt can plausibly clear. Everything else
 * ('consent_missing', 'not_connected', 'forbidden', 'not_found') is a
 * standing condition, not an outage, and must not soften a deny — see the
 * module docstring.
 */
const RETRYABLE_GRAPH_KINDS: ReadonlySet<M365ErrorKind> = new Set([
  'rate_limited',
  'graph_error',
]);

/**
 * Whether a thrown lookup failure was transient. Reads `kind` off the error
 * rather than testing `instanceof M365Error`: the class lives behind the
 * lazy graphApi import below (a static one would drag next-auth into every
 * module that reaches the sync evaluation paths), and callers mocking that
 * module supply only `graphJson`. A non-M365Error — a network fault, a
 * timeout, an aborted socket — is retryable by default; only a typed,
 * structural kind hardens the deny.
 */
function isRetryableGraphFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'M365Error') return true;
  const { kind } = error as Error & { kind?: unknown };
  if (typeof kind !== 'string') return true;
  return RETRYABLE_GRAPH_KINDS.has(kind as M365ErrorKind);
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
  groupIds: string[];
  expiresAt: number;
  /**
   * True only for the FAILURE_TTL_MS negative-cache entry written when the
   * Graph call threw a RETRYABLE failure — it distinguishes "we asked and
   * the user is in no listed group" from "we could not ask, but should be
   * able to shortly". Absent/false on every successful lookup, on every
   * view-as override, and on a structural failure (see the module
   * docstring), which stays a plain "no groups".
   */
  degraded?: boolean;
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

/** Live entry for a key, evicting it on expiry; null when cold or expired. */
function readEntry(
  map: Map<string, CacheEntry>,
  key: string,
): CacheEntry | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    map.delete(key);
    return null;
  }
  return entry;
}

function readCache(map: Map<string, CacheEntry>, key: string): string[] | null {
  return readEntry(map, key)?.groupIds ?? null;
}

function writeCache(
  userId: string,
  mail: string | undefined,
  groupIds: string[],
  ttl: number,
  degraded: boolean,
): void {
  // Oldest-first eviction keeps the maps bounded on busy multi-user replicas.
  for (const map of [cacheById, cacheByMail]) {
    if (map.size >= MAX_CACHE_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  // One entry object shared by both maps, so `degraded` reads identically
  // whether the caller looks the user up by id or by mail.
  const entry: CacheEntry = { groupIds, expiresAt: Date.now() + ttl, degraded };
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
 * True when this user's last group lookup failed RETRYABLY and the
 * negative-cache entry is still live — i.e. the [] returned by
 * `getCachedGroupIdsForUser` means "could not ask Graph just now", not
 * "member of nothing" and not "will never be able to ask".
 *
 * A cold/absent cache reports false on purpose: only a recorded failure
 * softens a deny, so a user who genuinely matches no rule still gets a hard
 * one. A live view-as override is authoritative membership for the session
 * and is never degraded.
 */
export function isGroupMembershipDegradedForUser(userId: string): boolean {
  if (readEntry(viewAsById, userId)) return false;
  return readEntry(cacheById, userId)?.degraded === true;
}

/** Mail-keyed counterpart for the agent-access evaluator. */
export function isGroupMembershipDegraded(
  mail: string | null | undefined,
): boolean {
  const normalized = normalizeMail(mail);
  if (!normalized) return false;
  if (readEntry(viewAsByMail, normalized)) return false;
  return readEntry(cacheByMail, normalized)?.degraded === true;
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
      writeCache(userId, mail, groupIds, CACHE_TTL_MS, false);
      return groupIds;
    } catch (error) {
      // Degraded evaluation (fourth pass A1): group clauses evaluate false
      // for this user until the negative cache expires, while user/domain
      // clauses keep working. Audit it — a quiet Graph outage must not look
      // like a correct deny. Agent access additionally reads the `degraded`
      // marker below and reports 'unavailable' for group-scoped rules
      // rather than denying; usage limits stay fail-open on the plain [].
      //
      // Only a transient failure earns that marker. A structural one is
      // logged just as loudly (the kind rides the audit line, so a missing
      // tenant grant is still traceable) but leaves `degraded` false, so
      // group-scoped rules go back to denying instead of softening for the
      // lifetime of the gap.
      const retryable = isRetryableGraphFailure(error);
      console.warn(
        `[agent-access-audit] group-membership degraded user=${sanitizeForLog(userId)} ` +
          `retryable=${retryable} ` +
          `reason=${sanitizeForLog(error instanceof Error ? error.message.slice(0, 120) : 'unknown')}`,
      );
      // Negative-cache briefly so a consent gap doesn't hammer Graph.
      writeCache(userId, mail, [], FAILURE_TTL_MS, retryable);
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
