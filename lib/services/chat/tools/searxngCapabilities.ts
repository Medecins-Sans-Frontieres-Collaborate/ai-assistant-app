/**
 * What the SearXNG instance offers, discovered at run time from `GET /config`
 * (docs/WEB_SEARCH_DEAD_END_PROPOSAL.md, "what they need to know about each
 * other").
 *
 * The app never names engines: categories are the contract with the
 * instance (ai-assistant-terraform/docs/SEARXNG_MULTI_STEP_CHANGES.md). This
 * module tells the search client which categories exist and which engines
 * belong to each, so that
 *  - a category the instance gained (`web`, `videos`) is usable the day it
 *    is deployed and a missing one degrades gracefully;
 *  - "web coverage" — did a full-text web engine answer? — can be computed
 *    from each result's `engine` without the app knowing engine names.
 *
 * Tolerant by design: the proxy may not admit `/config` yet (401), the
 * instance may be unreachable (local dev), the JSON may change shape. Any
 * of that yields `null`, logged once per cooldown, and every caller falls
 * back to its static behaviour. Never awaited on a request's critical path
 * beyond a short timeout.
 */
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

export interface SearxngCapabilities {
  categories: Set<string>;
  /** engine name → categories it serves. */
  engineCategories: Map<string, string[]>;
  fetchedAt: number;
}

/** The instance-side tag for full-text web engines (settings.yml). */
export const WEB_ENGINE_CATEGORY = 'web';

const CACHE_TTL_MS = 60 * 60_000;
const FAILURE_COOLDOWN_MS = 10 * 60_000;
const REQUEST_BUDGET_MS = 5_000;

let cached: SearxngCapabilities | null = null;
let lastFailureAt = 0;
let inFlight: Promise<SearxngCapabilities | null> | null = null;

/** Test-only. */
export function __resetSearxngCapabilitiesForTests(): void {
  cached = null;
  lastFailureAt = 0;
  inFlight = null;
}

export function parseSearxngConfig(body: unknown): SearxngCapabilities | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as { categories?: unknown; engines?: unknown };
  const categories = new Set<string>();
  const engineCategories = new Map<string, string[]>();
  for (const category of Array.isArray(raw.categories) ? raw.categories : []) {
    if (typeof category === 'string' && category) categories.add(category);
  }
  for (const engine of Array.isArray(raw.engines) ? raw.engines : []) {
    if (!engine || typeof engine !== 'object') continue;
    const {
      name,
      categories: list,
      enabled,
    } = engine as {
      name?: unknown;
      categories?: unknown;
      enabled?: unknown;
    };
    if (typeof name !== 'string' || !name || enabled === false) continue;
    const own = (Array.isArray(list) ? list : []).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    engineCategories.set(name, own);
    own.forEach((category) => categories.add(category));
  }
  if (engineCategories.size === 0) return null;
  return { categories, engineCategories, fetchedAt: Date.now() };
}

async function fetchCapabilities(): Promise<SearxngCapabilities | null> {
  const base = env.SEARXNG_URL ?? '';
  const url = new URL('config', base.endsWith('/') ? base : `${base}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_BUDGET_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'X-Search-Key': env.SEARXNG_API_KEY ?? '',
        Accept: 'application/json',
      },
      // Same rule as the search request: the shared secret never follows a
      // redirect to another host.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SearXNG /config returned ${response.status}`);
    }
    const parsed = parseSearxngConfig(await response.json());
    if (!parsed) throw new Error('SearXNG /config had no engines');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The instance's capabilities, or null when unknown. Cached for an hour;
 * a failure is remembered for ten minutes so a proxy that does not admit
 * `/config` costs one request per replica per ten minutes, not one per
 * search. Concurrent callers share one fetch.
 */
export async function getSearxngCapabilities(): Promise<SearxngCapabilities | null> {
  if (!env.SEARXNG_URL || !env.SEARXNG_API_KEY) return null;
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  if (now - lastFailureAt < FAILURE_COOLDOWN_MS) return cached;
  if (!inFlight) {
    inFlight = fetchCapabilities()
      .then((result) => {
        cached = result;
        lastFailureAt = 0;
        console.log(
          `[searxngCapabilities] categories: ${[...result!.categories].join(', ')}; engines: ${result!.engineCategories.size}`,
        );
        return result;
      })
      .catch((error) => {
        lastFailureAt = Date.now();
        console.warn(
          `[searxngCapabilities] /config unavailable (serving ${cached ? 'last-known' : 'static defaults'}): ${sanitizeForLog(error instanceof Error ? error.message : String(error))}`,
        );
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Engine names the instance tags as full-text web engines; empty = unknown. */
export function webEnginesOf(
  capabilities: SearxngCapabilities | null,
): Set<string> {
  const engines = new Set<string>();
  if (!capabilities) return engines;
  for (const [engine, categories] of capabilities.engineCategories) {
    if (categories.includes(WEB_ENGINE_CATEGORY)) engines.add(engine);
  }
  return engines;
}
