/**
 * User-tunable web search options (Settings → Search Mode → Advanced).
 *
 * These shape the app-controlled layer of the search round-trip: how many
 * sources are kept, and what recency the search agent is instructed to
 * prefer. (Bing-tool-level `count`/`freshness`/`market` live on the Foundry
 * agent DEFINITION — infra config, not per-request.)
 */
/**
 * User-selectable search backend. 'auto' defers to the deployment default
 * (WEB_SEARCH_PROVIDER env). The feed providers work in every deployment;
 * 'bing-agent' needs the Foundry search agent — where that infrastructure
 * is absent, a search on it degrades to a knowledge answer with a notice.
 * 'combined' runs the Bing agent and the Google News feed concurrently:
 * headlines surface as soon as the feed answers, the Bing summary joins
 * when the agent finishes (35-90s), and the two are merged. Where the
 * Foundry agent is absent it degrades to the feed result alone.
 * 'bing-responses' is the native web_search tool on the Azure OpenAI
 * Responses API — the same Bing grounding as 'bing-agent' but a direct
 * model call instead of a Foundry agent run (A/B latency candidate).
 */
export type WebSearchProviderOption =
  | 'auto'
  | 'news'
  | 'google-news'
  | 'gdelt'
  | 'bing-agent'
  | 'bing-responses'
  | 'combined';

export const WEB_SEARCH_PROVIDER_OPTIONS: WebSearchProviderOption[] = [
  'auto',
  'news',
  'google-news',
  'gdelt',
  'bing-agent',
  'bing-responses',
  'combined',
];

export interface WebSearchOptions {
  /**
   * Maximum distinct sources kept from a search (citation cap). Bounded
   * [MIN_SEARCH_RESULT_COUNT, MAX_SEARCH_RESULT_COUNT] server-side.
   */
  resultCount: number;
  /**
   * Recency preference passed to the search agent.
   * 'auto' lets the per-message router decide (e.g. "latest news" → day);
   * the others force the preference for every search.
   */
  freshness: 'auto' | 'day' | 'week' | 'month' | 'any';
  /** Which search backend runs the query ('auto' = deployment default). */
  provider: WebSearchProviderOption;
}

export const MIN_SEARCH_RESULT_COUNT = 3;
export const MAX_SEARCH_RESULT_COUNT = 15;

export const DEFAULT_WEB_SEARCH_OPTIONS: WebSearchOptions = {
  resultCount: 8,
  freshness: 'auto',
  provider: 'combined',
};

/**
 * One headline from the fast (Google News) leg of a combined search —
 * streamed to the client mid-search so the wait for Bing shows real
 * content, and echoed back verbatim on "Summarize from headlines" resends
 * so the server can rebuild the digest without re-searching.
 */
export interface SearchHeadlineEntry {
  title: string;
  url: string;
  date: string;
  sourceName?: string;
  sourceUrl?: string;
  snippet?: string;
}

/**
 * Client-echoed search results for a "Summarize from headlines" resend:
 * the interim headlines the user already saw, sent back in place of a
 * fresh search (the server is stateless — same pattern as mcpPlan).
 */
export interface PrecomputedSearchResults {
  /** The queries the interim results answered (display/record only). */
  queries: string[];
  entries: SearchHeadlineEntry[];
}

export function isWebSearchProviderOption(
  value: unknown,
): value is WebSearchProviderOption {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_PROVIDER_OPTIONS as string[]).includes(value)
  );
}

export function isWebSearchFreshness(
  value: unknown,
): value is WebSearchOptions['freshness'] {
  return (
    value === 'auto' ||
    value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'any'
  );
}

/** Clamps arbitrary persisted/client values to a valid options object. */
export function sanitizeWebSearchOptions(value: unknown): WebSearchOptions {
  const raw = (value ?? {}) as Partial<WebSearchOptions>;
  const resultCount =
    typeof raw.resultCount === 'number' && Number.isFinite(raw.resultCount)
      ? Math.min(
          MAX_SEARCH_RESULT_COUNT,
          Math.max(MIN_SEARCH_RESULT_COUNT, Math.round(raw.resultCount)),
        )
      : DEFAULT_WEB_SEARCH_OPTIONS.resultCount;
  const freshness = isWebSearchFreshness(raw.freshness)
    ? raw.freshness
    : DEFAULT_WEB_SEARCH_OPTIONS.freshness;
  const provider = isWebSearchProviderOption(raw.provider)
    ? raw.provider
    : DEFAULT_WEB_SEARCH_OPTIONS.provider;
  return { resultCount, freshness, provider };
}
