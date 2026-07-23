/**
 * User-tunable web search options (Settings → Search Mode → Advanced).
 *
 * These shape the app-controlled layer of the search round-trip: how many
 * sources are kept, and what recency the search agent is instructed to
 * prefer. (Bing-tool-level `count`/`freshness`/`market` live on the Foundry
 * agent DEFINITION — infra config, not per-request.)
 */
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
}

export const MIN_SEARCH_RESULT_COUNT = 3;
export const MAX_SEARCH_RESULT_COUNT = 15;

export const DEFAULT_WEB_SEARCH_OPTIONS: WebSearchOptions = {
  resultCount: 8,
  freshness: 'auto',
};

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
  return { resultCount, freshness };
}
