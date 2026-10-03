import { ResolvedWebSearchProvider } from '@/types/webSearch';

import { Tool, ToolResult, WebSearchToolParams } from './Tool';
import { searchGoogleNews } from './googleNewsSearch';
import {
  NewsEntry,
  buildNewsResult,
  fetchGoogleNewsHeadlines,
  searchNewsFanOut,
  searchNewsParallel,
} from './newsSearch';
import { executeResponsesWebSearch } from './responsesWebSearch';
import { WEB_ENGINE_CATEGORY } from './searxngCapabilities';
import {
  SearxngSearchOptions,
  SearxngSearchOutcome,
  isSearxngConfigured,
  planSearxngCategories,
  searchSearxng,
} from './searxngSearch';

import { env } from '@/config/environment';

/**
 * Deployment default backend — what the user-facing 'auto' resolves to. An
 * explicit WEB_SEARCH_PROVIDER pins it; otherwise Bing. SearXNG stays
 * opt-in (Settings → MSF web search) until the instance's upstream engines
 * hold up under a full deployment; where a user picks it, an unavailable
 * instance falls back to Bing (see searxngFallback).
 */
export function resolveDefaultWebSearchProvider(): ResolvedWebSearchProvider {
  return env.WEB_SEARCH_PROVIDER ?? 'bing';
}

/** Which backend answered in place of an unavailable SearXNG instance. */
export type SearxngFallbackProvider = 'bing' | 'news';

/**
 * WebSearchTool
 *
 * Executes web searches on the configured backend: MSF's own SearXNG
 * instance, the keyless news feeds, or Bing through the Responses API's
 * native web_search tool (no Foundry agent involved). Only the search query
 * leaves the app, never the conversation, preserving user privacy.
 *
 * No result caching: each request runs the full search. An in-memory or
 * cross-request cache would create a window where one user's queries
 * could be inferred by another via side channels (timing, cache size,
 * eviction patterns). MSF's privacy posture forbids that trade — the
 * latency cost is worth the guarantee.
 */
export class WebSearchTool implements Tool {
  readonly type = 'web_search' as const;
  readonly name = 'Web Search';
  readonly description =
    'Searches the web for current information, news, and real-time data';

  /**
   * Executes a web search.
   *
   * @param params - Web search parameters including query and model
   * @returns Search results with text and citations
   */
  async execute(params: WebSearchToolParams): Promise<ToolResult> {
    // Caller-resolved provider (user setting) wins; the env default covers
    // callers that don't resolve one.
    const provider = params.provider ?? resolveDefaultWebSearchProvider();
    try {
      console.log(
        `[WebSearchTool] Executing search via ${provider}: "${params.searchQuery}"`,
      );

      // SearXNG: MSF's own metasearch instance. Unconfigured, unreachable,
      // empty, or its web engines not answering → Bing answers instead
      // (then the keyless news feeds), so local dev (no route to the
      // private endpoint), a key-rotation gap longer than the client's
      // single retry, and an upstream outage still get results.
      if (provider === 'searxng') {
        const searx = await this.executeSearxng(params);
        if (searx.result && !searx.degraded) return searx.result;
        return await this.searxngFallback(params, searx.result);
      }

      // Combined: Bing + Google News feed concurrently — headlines surface
      // via onInterimResults while Bing runs, then the two merge.
      if (provider === 'combined') {
        return await this.executeCombined(params);
      }

      // Bing: the Responses API's native web_search tool — one model call
      // on the user's region, no Foundry agent.
      if (provider === 'bing') {
        const result = await this.executeBing(params);
        console.log(
          `[WebSearchTool] Bing web_search completed: ${result.text.length} chars, ${result.citations?.length ?? 0} citations`,
        );
        return result;
      }

      // Feed-based providers: no LLM round-trip.
      return await this.executeFeeds(provider, params);
    } catch (error) {
      console.error('[WebSearchTool] Search failed:', error);

      // Return error message instead of failing silently
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown search error';
      return {
        text: `\n\n*Note: Web search encountered an issue: ${errorMessage}. Continuing without search results.*\n\n`,
        citations: [],
      };
    }
  }

  /**
   * What answers when SearXNG cannot (instance down, or its upstream web
   * engines not answering): Bing first — a real web search, so it covers
   * every category — then the keyless news feeds. The result carries
   * `searxngFallback` plus `fallbackProvider` so records and the model's
   * note say which backend answered.
   *
   * `degraded` is a SearXNG result whose web engines did not answer (the
   * reference/news engines may still have found something): kept as the
   * last resort when Bing cannot run, ahead of the news feeds.
   *
   * The news feeds are skipped for science and programming questions:
   * headlines answer a news or general question, but for a science or
   * programming question they are noise the model would dutifully cite.
   * There, an honest "found nothing" (the enricher's knowledge-answer path)
   * is the better degradation.
   */
  async searxngFallback(
    params: WebSearchToolParams,
    degraded?: ToolResult | null,
  ): Promise<ToolResult> {
    try {
      const bing = await this.executeBing(params);
      if ((bing.citations?.length ?? 0) > 0 || bing.text.trim().length > 0) {
        console.log(
          `[WebSearchTool] Bing answered in place of SearXNG: ${bing.citations?.length ?? 0} citations`,
        );
        return {
          ...bing,
          metadata: {
            ...bing.metadata,
            searxngFallback: true,
            fallbackProvider: 'bing' satisfies SearxngFallbackProvider,
          },
        };
      }
      console.warn(
        '[WebSearchTool] Bing fallback returned nothing; using the news feeds',
      );
    } catch (error) {
      // A search that lost the race is over — no second backend.
      if (params.signal?.aborted) throw error;
      console.warn(
        '[WebSearchTool] Bing fallback failed; using the news feeds:',
        error instanceof Error ? error.message : error,
      );
    }
    if (degraded && (degraded.citations?.length ?? 0) > 0) {
      return {
        ...degraded,
        text:
          `Search note: the web search engines behind the search service did not answer for this request; ` +
          `these results come from its news and reference engines only, so they may be beside the point. ` +
          `Say so briefly, and answer only what they genuinely support.\n\n${degraded.text}`,
        metadata: { ...degraded.metadata, searxngDegraded: true },
      };
    }
    const fallbackProvider: SearxngFallbackProvider = 'news';
    if (params.category === 'science' || params.category === 'it') {
      return {
        text: '',
        citations: [],
        metadata: { searxngFallback: true, fallbackProvider },
      };
    }
    const fallback = await this.executeFeeds('news', params);
    return {
      ...fallback,
      metadata: {
        ...fallback.metadata,
        searxngFallback: true,
        fallbackProvider,
      },
    };
  }

  /**
   * Raw SearXNG results for the multi-step search, which assembles its own
   * digest across several steps. Throws when the instance is unconfigured
   * or unavailable; an empty result is returned as such.
   */
  async searchSearxngEntries(
    queries: string[],
    options: SearxngSearchOptions,
  ): Promise<SearxngSearchOutcome> {
    return searchSearxng(queries.slice(0, 5), options);
  }

  /**
   * SearXNG search. A null result means the caller should fall back:
   * instance unconfigured, every leg failed, or nothing found. `degraded`
   * marks a result whose web engines did not answer (the same signal the
   * multi-step loop's 'degraded' outcome rests on) — only judged where the
   * plan asked the web engines at all: a news- or science-only plan never
   * expects them, so their silence there means nothing.
   */
  private async executeSearxng(
    params: WebSearchToolParams,
  ): Promise<{ result: ToolResult | null; degraded: boolean }> {
    if (!isSearxngConfigured()) {
      console.warn('[WebSearchTool] SearXNG is not configured; falling back');
      return { result: null, degraded: false };
    }
    const queries = params.searchQueries?.length
      ? params.searchQueries.slice(0, 5)
      : [params.searchQuery];
    const options = {
      resultCount: params.resultCount ?? 8,
      freshness: params.freshness ?? 'any',
      category: params.category,
      deep: params.deep ?? false,
    } as const;
    try {
      const outcome = await searchSearxng(queries, options);
      if (outcome.entries.length === 0) {
        console.warn(
          '[WebSearchTool] SearXNG returned no results; falling back',
        );
        return { result: null, degraded: false };
      }
      const plan = planSearxngCategories(options);
      const degraded =
        outcome.health?.webCoverage === false &&
        (plan.includes('general') || plan.includes(WEB_ENGINE_CATEGORY));
      if (degraded) {
        console.warn(
          `[WebSearchTool] SearXNG web engines did not answer (${outcome.entries.length} results from other engines); falling back`,
        );
      }
      console.log(
        `[WebSearchTool] SearXNG (${params.category ?? 'general'}): ${outcome.entries.length} results across ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`,
      );
      const digest = buildNewsResult(
        outcome.entries,
        // A planning failure passes the raw user message as the query —
        // keep the digest header a label, not a second copy of the prompt.
        queries.map((q) => `"${q.slice(0, 120)}"`).join('; '),
        'web',
      );
      const answerLead =
        outcome.answers.length > 0
          ? `Instant answer from the search engine (verify against the sources below): ${outcome.answers.join(' | ')}\n\n`
          : '';
      return {
        result: {
          text: `${answerLead}${digest.text}`,
          citations: digest.citations,
        },
        degraded,
      };
    } catch (error) {
      console.warn(
        '[WebSearchTool] SearXNG search failed; falling back:',
        error instanceof Error ? error.message : error,
      );
      return { result: null, degraded: false };
    }
  }

  /** Bing through the Responses API web_search tool, on the user's region. */
  private executeBing(params: WebSearchToolParams): Promise<ToolResult> {
    return executeResponsesWebSearch({
      searchQuery: params.searchQuery,
      resultCount: params.resultCount,
      freshness: params.freshness,
      deep: params.deep,
      region: params.user?.region,
      onUsage: params.onUsage,
      signal: params.signal,
    });
  }

  /**
   * Keyless feed providers. 'news' fans out to GDELT + Google News in
   * parallel so each backs the other up.
   */
  private async executeFeeds(
    provider: ResolvedWebSearchProvider,
    params: WebSearchToolParams,
  ): Promise<ToolResult> {
    const feedOptions = {
      resultCount: params.resultCount ?? 8,
      freshness: params.freshness ?? 'any',
    } as const;
    // Multi-aspect fan-out: one Google News leg per query, in
    // parallel (GDELT excluded — its rate-limit queue would serialize
    // the legs; see searchNewsFanOut). Only providers that include
    // Google News fan out — a GDELT-only selection must stay GDELT,
    // so it takes the single-query path below on its primary query.
    const fanOutQueries =
      provider !== 'gdelt' && (params.searchQueries?.length ?? 0) > 1
        ? params.searchQueries!.slice(0, 5)
        : null;
    if (fanOutQueries) {
      const fanned = await searchNewsFanOut(fanOutQueries, feedOptions);
      console.log(
        `[WebSearchTool] Fan-out across ${fanOutQueries.length} queries: ${fanned.citations.length} merged citations`,
      );
      return { text: fanned.text, citations: fanned.citations };
    }
    if (provider === 'google-news') {
      const newsResults = await searchGoogleNews(
        params.searchQuery,
        feedOptions,
      );
      return { text: newsResults.text, citations: newsResults.citations };
    }
    const newsResults = await searchNewsParallel(
      params.searchQuery,
      feedOptions,
      {
        sources: provider === 'gdelt' ? ['gdelt'] : ['gdelt', 'google-news'],
        deep: params.deep ?? false,
      },
    );
    console.log(
      `[WebSearchTool] News providers used: ${
        newsResults.providersUsed.join(', ') || 'none'
      }`,
    );
    return { text: newsResults.text, citations: newsResults.citations };
  }

  /**
   * Combined provider: the Bing-grounding agent (deep summaries, real
   * URLs, 35-90s) and the Google News feed (headlines, sub-second) run
   * CONCURRENTLY. The feed's headlines fire `onInterimResults` as soon as
   * they land — the caller streams them to the client so the Bing wait
   * shows real content (and offers "Summarize from headlines"). When the
   * agent finishes, its result leads and non-duplicate headlines are
   * appended. Either leg failing degrades to the other alone; only both
   * failing throws.
   */
  private async executeCombined(
    params: WebSearchToolParams,
  ): Promise<ToolResult> {
    const feedOptions = {
      resultCount: params.resultCount ?? 8,
      freshness: params.freshness ?? 'any',
    } as const;
    const queries = params.searchQueries?.length
      ? params.searchQueries.slice(0, 5)
      : [params.searchQuery];
    const label = queries.map((q) => `"${q}"`).join('; ');

    const newsPromise: Promise<NewsEntry[]> = fetchGoogleNewsHeadlines(
      queries,
      feedOptions,
    )
      .then((entries) => {
        if (entries.length > 0) {
          console.log(
            `[WebSearchTool] Combined: ${entries.length} interim headlines ready (Bing still running)`,
          );
          params.onInterimResults?.(entries);
        }
        return entries;
      })
      .catch((error) => {
        console.warn(
          '[WebSearchTool] Combined: news leg failed (continuing with Bing):',
          error instanceof Error ? error.message : error,
        );
        return [] as NewsEntry[];
      });

    const bingSettled = await this.executeBing(params)
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error }));
    const entries = await newsPromise;

    if (!bingSettled.ok) {
      console.warn(
        '[WebSearchTool] Combined: Bing leg failed; returning news headlines alone:',
        bingSettled.error instanceof Error
          ? bingSettled.error.message
          : bingSettled.error,
      );
      if (entries.length === 0) {
        throw bingSettled.error instanceof Error
          ? bingSettled.error
          : new Error(String(bingSettled.error));
      }
      // The answer must level with the user about the degraded coverage:
      // the note instructs the model, and `bingFailed` lets the enricher's
      // tool record say the same.
      const digest = buildNewsResult(entries, label);
      return {
        text:
          `Note: the deep web search (Bing) FAILED for this request, so the results below are Google News headlines only. ` +
          `Briefly mention ONCE that the deeper search was unavailable and this answer is based on news headlines.\n\n` +
          digest.text,
        citations: digest.citations,
        metadata: { bingFailed: true },
      };
    }

    const bing = bingSettled.value;
    if (entries.length === 0) {
      return bing;
    }
    if ((bing.citations?.length ?? 0) === 0 && bing.text.trim().length === 0) {
      return buildNewsResult(entries, label);
    }

    // Merge: Bing's summary + citations lead (deep, real URLs); headline
    // entries the agent didn't already cite are appended with continued
    // numbering. The enricher's cap keeps the total at the user's source
    // count, preferring the Bing block.
    const seenUrls = new Set((bing.citations ?? []).map((c) => c.url));
    const freshEntries = entries.filter((e) => !seenUrls.has(e.url));
    // Continue numbering after the HIGHEST Bing citation number (not the
    // count) — agent numbering can be non-contiguous, and a collision
    // would corrupt the enricher's renumbering map.
    const offset = Math.max(0, ...(bing.citations ?? []).map((c) => c.number));
    const headlineCitations = freshEntries.map((entry, idx) => ({
      number: offset + idx + 1,
      title: entry.title,
      url: entry.url,
      date: entry.date,
      ...(entry.sourceName ? { sourceName: entry.sourceName } : {}),
      ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    }));
    if (headlineCitations.length === 0) {
      return bing;
    }

    const headlineDigest = freshEntries
      .map((entry, idx) => {
        const meta = [entry.sourceName, entry.date].filter(Boolean).join(', ');
        return `[${offset + idx + 1}] ${entry.title}${meta ? ` (${meta})` : ''}${
          entry.snippet ? `\n${entry.snippet}` : ''
        }`;
      })
      .join('\n\n');

    return {
      text:
        `${bing.text}\n\n` +
        `Additional recent headlines for ${label} (cite by number where relevant):\n\n` +
        headlineDigest,
      citations: [...(bing.citations ?? []), ...headlineCitations],
      // Keep what the Bing leg reported about itself (the deployment it
      // ran on): the tool record names it.
      metadata: { ...bing.metadata, merged: true },
    };
  }
}
