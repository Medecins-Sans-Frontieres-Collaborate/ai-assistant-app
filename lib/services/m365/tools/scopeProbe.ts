/**
 * Consent scope probe for the M365 toolset (fourth pass B4): each distinct
 * catalog scope is probed with a single-scope delegated token mint — granted
 * scopes go in the set, consent gaps stay out — so listTools() can omit
 * tools that can only fail. Partial consent silently shrinks the toolset.
 *
 * Cache posture mirrors groupMembership.ts: in-process per-user TTL cache,
 * bounded, in-flight dedupe, and a short negative cache when the probe
 * itself fails (not-connected / Graph outage) so a broken session doesn't
 * hammer the token endpoint. Probe failure ⇒ empty set ⇒ empty listing.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { M365_TOOL_SCOPES } from '@/lib/services/m365/tools/toolCatalog';

const CACHE_TTL_MS = 15 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
  scopes: Set<string>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Set<string>>>();

function readCache(userId: string): Set<string> | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return entry.scopes;
}

function writeCache(userId: string, scopes: Set<string>, ttl: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { scopes, expiresAt: Date.now() + ttl });
}

/**
 * The granted subset of M365_TOOL_SCOPES for this user. Never throws:
 * without a user id (or when every probe faults) the set is empty.
 */
export async function probeGrantedScopes(
  req: NextRequest,
  session: Session,
): Promise<Set<string>> {
  const userId = session.user?.id;
  if (!userId) return new Set();

  const cached = readCache(userId);
  if (cached !== null) return cached;

  const running = inFlight.get(userId);
  if (running) return running;

  const probePromise = (async () => {
    try {
      // Lazy import: static graphApi imports drag next-auth into every
      // consumer module graph (see groupMembership.ts).
      const { mintGraphToken } = await import('@/lib/services/m365/graphApi');
      let hardFailure = false;
      const results = await Promise.all(
        M365_TOOL_SCOPES.map(async (scope) => {
          try {
            await mintGraphToken(req, [scope]);
            return scope;
          } catch (error) {
            // consent_missing is a real answer (scope not granted) and
            // cacheable for the full TTL; anything else (not_connected,
            // Graph outage) marks the probe degraded.
            const kind =
              error && typeof error === 'object' && 'kind' in error
                ? (error as { kind?: string }).kind
                : undefined;
            if (kind !== 'consent_missing') hardFailure = true;
            return null;
          }
        }),
      );
      const granted = new Set(
        results.filter((scope): scope is string => scope !== null),
      );
      const degraded = granted.size === 0 && hardFailure;
      writeCache(userId, granted, degraded ? FAILURE_TTL_MS : CACHE_TTL_MS);
      return granted;
    } finally {
      inFlight.delete(userId);
    }
  })();
  inFlight.set(userId, probePromise);
  return probePromise;
}

/** Test hook — listing semantics depend on cache state. */
export function clearScopeProbeCache(): void {
  cache.clear();
  inFlight.clear();
}
