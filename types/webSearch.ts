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
 * (WEB_SEARCH_PROVIDER env). The feed providers work in every deployment.
 * 'bing' is Bing grounding through the native web_search tool on the Azure
 * OpenAI Responses API — one direct model call on the user's region, no
 * Foundry agent (the deployment is picked by lib/services/models/
 * webSearchModel.ts). 'combined' runs Bing and the Google News feed
 * concurrently: headlines surface as soon as the feed answers, the Bing
 * summary joins when it finishes, and the two are merged.
 * 'searxng' is MSF's own SearXNG metasearch instance — general web plus
 * news/science/IT/humanitarian engines, seconds-fast, real publisher URLs.
 * Where the instance is unconfigured, unreachable or its web engines do
 * not answer, it degrades to 'bing', then to 'news'.
 *
 * 'bing-agent' and 'bing-responses' were the two earlier Bing routes (a
 * hand-made Foundry agent, and this one); persisted settings and older
 * clients still send them and are read as 'bing'.
 */
export type WebSearchProviderOption =
  | 'auto'
  | 'searxng'
  | 'news'
  | 'google-news'
  | 'gdelt'
  | 'bing'
  | 'combined';

/** Earlier names for 'bing', accepted wherever a provider is read. */
export const LEGACY_BING_PROVIDERS: readonly string[] = [
  'bing-agent',
  'bing-responses',
];

/** A concrete backend — what 'auto' resolves to server-side. */
export type ResolvedWebSearchProvider = Exclude<
  WebSearchProviderOption,
  'auto'
>;

export const WEB_SEARCH_PROVIDER_OPTIONS: WebSearchProviderOption[] = [
  'auto',
  'searxng',
  'news',
  'google-news',
  'gdelt',
  'bing',
  'combined',
];

/**
 * Topic categories the SearXNG instance serves (its engine allow-list):
 * 'general' web, 'news', 'science' (MSF Science Portal, Europe PMC, PubMed,
 * OpenAlex, …), 'it' (GitHub, Stack Overflow, MDN) and 'humanitarian'
 * (OCHA HDX datasets). Picked per message by the tool router; providers
 * other than 'searxng' ignore it.
 */
export type WebSearchCategory =
  | 'general'
  | 'news'
  | 'science'
  | 'it'
  | 'humanitarian';

export const WEB_SEARCH_CATEGORIES: WebSearchCategory[] = [
  'general',
  'news',
  'science',
  'it',
  'humanitarian',
];

export function isWebSearchCategory(
  value: unknown,
): value is WebSearchCategory {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_CATEGORIES as string[]).includes(value)
  );
}

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
  /**
   * Multi-step search (MSF web search only): after the first results an
   * assessor may search again or read result pages before the answer is
   * written. On by default; false keeps every search to its single planned
   * round. An admin can also switch it off for everyone
   * (docs/WEB_SEARCH_MULTI_STEP.md). Absent (older persisted settings and
   * older clients) means on.
   */
  multiStep: boolean;
}

export const MIN_SEARCH_RESULT_COUNT = 3;
export const MAX_SEARCH_RESULT_COUNT = 15;

export const DEFAULT_WEB_SEARCH_OPTIONS: WebSearchOptions = {
  resultCount: 8,
  freshness: 'auto',
  // 'auto' lets the deployment pick (Bing unless WEB_SEARCH_PROVIDER pins
  // another), so backend changes reach users without another store
  // migration.
  provider: 'auto',
  multiStep: true,
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

/** Which search an interim panel / echoed result set came from. */
export type SearchInterimKind = 'combined' | 'multiStep';

/**
 * Client-echoed search results for a "Summarize from headlines" resend:
 * the interim headlines the user already saw, sent back in place of a
 * fresh search (the server is stateless — same pattern as mcpPlan).
 */
export interface PrecomputedSearchResults {
  /** The queries the interim results answered (display/record only). */
  queries: string[];
  entries: SearchHeadlineEntry[];
  /** Absent on echoes from older clients: a combined (news) search. */
  kind?: SearchInterimKind;
}

export function isWebSearchProviderOption(
  value: unknown,
): value is WebSearchProviderOption {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_PROVIDER_OPTIONS as string[]).includes(value)
  );
}

/** A provider as persisted or sent, with the legacy Bing names folded in. */
export function normalizeWebSearchProvider(
  value: unknown,
): WebSearchProviderOption | undefined {
  if (typeof value === 'string' && LEGACY_BING_PROVIDERS.includes(value)) {
    return 'bing';
  }
  return isWebSearchProviderOption(value) ? value : undefined;
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
  const provider =
    normalizeWebSearchProvider(raw.provider) ??
    DEFAULT_WEB_SEARCH_OPTIONS.provider;
  // Only an explicit false opts out — settings persisted before the option
  // existed carry no value and must get the default.
  const multiStep = raw.multiStep !== false;
  return { resultCount, freshness, provider, multiStep };
}
