import { discoverServedModels } from '@/lib/services/models/servedModels';

import { UserRegion } from '@/lib/utils/shared/region';

/**
 * Server-side lookup of the tokens-per-minute limit of the deployment a chat
 * request will be served by, so request planning can respect the
 * deployment's admission ceiling (lib/utils/shared/modelThroughput.ts).
 *
 * The chat pipeline builds model configs from the static catalog, which has
 * no deployment facts; the served-model list (discovery) does. Reading it
 * costs an ARM token acquisition on every call even when discovery itself is
 * cached — measured at ~1.7 s per turn locally — so this module keeps its own
 * per-region TPM map: fresh entries answer immediately, stale ones answer
 * immediately while a refresh runs, and only a region's first lookup waits,
 * bounded by a timeout. A refresh that outlives the timeout still lands in
 * the map for the next turn.
 *
 * Fails soft: any miss — static-list fallback, unknown model, provisioned
 * SKU, timeout, discovery error — returns undefined, which every consumer
 * treats as "no ceiling", i.e. the behaviour before this existed.
 */

/** Longest a turn waits for a region's first lookup before planning without it. */
export const THROUGHPUT_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * How long a region's TPM map is served without a refresh. Capacity changes
 * are rare operator actions; five minutes keeps a raise or cut visible
 * quickly without an ARM round trip per turn.
 */
export const THROUGHPUT_CACHE_TTL_MS = 5 * 60_000;

interface RegionThroughput {
  /** modelId -> TPM, for served models that carry a ceiling. */
  tokensPerMinuteById: Map<string, number>;
  fetchedAt: number;
}

interface ThroughputStore {
  cache: Map<UserRegion, RegionThroughput>;
  inFlight: Map<UserRegion, Promise<RegionThroughput | undefined>>;
}

/**
 * Process-wide store, kept on globalThis: Next bundles instrumentation.ts
 * (which warms it at boot) separately from the route handlers that read it,
 * and dev hot reloads re-evaluate this module. A plain module-level Map
 * would be a different, empty map in each case — and every empty lookup
 * costs a turn its ceiling (observed 2026-11-07: a cold EU lookup timed out
 * and a Luna interpreter turn was rate-limited mid-stream).
 */
const STORE_KEY = Symbol.for('ai-assistant.deploymentThroughput');
const globalStore = globalThis as typeof globalThis & {
  [STORE_KEY]?: ThroughputStore;
};
const store: ThroughputStore = (globalStore[STORE_KEY] ??= {
  cache: new Map(),
  inFlight: new Map(),
});
const { cache, inFlight } = store;

/** Fetches (once per region at a time) and stores a region's TPM map. */
function refreshRegion(
  region: UserRegion,
): Promise<RegionThroughput | undefined> {
  const pending = inFlight.get(region);
  if (pending) return pending;
  // The catch sits on the refresh itself, not around a caller's race: a
  // rejection that lands after the timeout has already won must still be
  // handled.
  const refresh = Promise.resolve()
    .then(() => discoverServedModels(region))
    .then(({ models }) => {
      const entry: RegionThroughput = {
        tokensPerMinuteById: new Map(
          models.flatMap((m) =>
            m.tokensPerMinute !== undefined
              ? [[m.id, m.tokensPerMinute] as const]
              : [],
          ),
        ),
        fetchedAt: Date.now(),
      };
      cache.set(region, entry);
      return entry;
    })
    .catch((error: unknown) => {
      console.warn(
        `[deploymentThroughput] TPM refresh failed for ${region}; planning without a ceiling:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    })
    .finally(() => inFlight.delete(region));
  inFlight.set(region, refresh);
  return refresh;
}

/**
 * Resolves the TPM limit of `modelId`'s deployment in `region`.
 *
 * @param modelId - Deployment/model id as served (e.g. "gpt-6-astra").
 * @param region - The region whose account will serve the request. The
 *        served list is home-region-first, so the entry found is that
 *        region's deployment whenever one exists there.
 * @param timeoutMs - Upper bound on waiting when the region has no map yet.
 * @returns The TPM limit, or undefined when it cannot be determined.
 */
export async function resolveServingTokensPerMinute(
  modelId: string,
  region: UserRegion,
  timeoutMs: number = THROUGHPUT_LOOKUP_TIMEOUT_MS,
): Promise<number | undefined> {
  const cached = cache.get(region);
  if (cached) {
    if (Date.now() - cached.fetchedAt > THROUGHPUT_CACHE_TTL_MS) {
      void refreshRegion(region);
    }
    return cached.tokensPerMinuteById.get(modelId);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const entry = await Promise.race([refreshRegion(region), timeout]);
    return entry?.tokensPerMinuteById.get(modelId);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Starts loading the TPM maps of `regions` without waiting, so the first
 * turns after boot plan with their deployment's ceiling instead of racing a
 * cold lookup. Never throws; a failed refresh is logged and retried by the
 * next lookup.
 *
 * @param regions - Regions to warm (default: every user region).
 */
export function warmServingThroughput(
  regions: readonly UserRegion[] = ['US', 'EU'],
): void {
  for (const region of regions) {
    if (!cache.has(region)) void refreshRegion(region);
  }
}

/** Test seam: forget every cached region and in-flight refresh. */
export function resetThroughputCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
