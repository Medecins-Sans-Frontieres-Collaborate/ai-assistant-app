import { AgentChatService } from '../AgentChatService';
import { Tool, ToolResult, WebSearchToolParams } from './Tool';
import { searchGoogleNews } from './googleNewsSearch';
import {
  NewsEntry,
  buildNewsResult,
  fetchGoogleNewsHeadlines,
  searchNewsFanOut,
  searchNewsParallel,
} from './newsSearch';

import { env } from '@/config/environment';

/**
 * WebSearchTool
 *
 * Executes web searches using AI Foundry agents.
 * Only the search query is sent to AI Foundry, not the full conversation,
 * preserving user privacy.
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

  constructor(private agentChatService: AgentChatService) {}

  /**
   * Executes a web search.
   *
   * @param params - Web search parameters including query and model
   * @returns Search results with text and citations
   */
  async execute(params: WebSearchToolParams): Promise<ToolResult> {
    // Caller-resolved provider (user setting) wins; the env default covers
    // callers that don't resolve one.
    const provider = params.provider ?? env.WEB_SEARCH_PROVIDER;
    try {
      console.log(
        `[WebSearchTool] Executing search via ${provider}: "${params.searchQuery}"`,
      );

      // Combined: Bing agent + Google News feed concurrently — headlines
      // surface via onInterimResults while the agent runs, then merge.
      if (provider === 'combined') {
        return await this.executeCombined(params);
      }

      // Feed-based providers: no LLM round-trip. 'news' (default) fans out
      // to GDELT + Google News in parallel so each backs the other up. The
      // Bing agent path below stays available via WEB_SEARCH_PROVIDER.
      if (provider !== 'bing-agent') {
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
            sources:
              provider === 'gdelt' ? ['gdelt'] : ['gdelt', 'google-news'],
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

      if (!params.model) {
        throw new Error('Bing-agent search requires an agent-backed model');
      }
      const searchResults = await this.agentChatService.executeWebSearchTool({
        searchQuery: params.searchQuery,
        model: params.model,
        user: params.user,
        resultCount: params.resultCount,
        freshness: params.freshness,
        onActivity: params.onActivity,
      });

      console.log(
        `[WebSearchTool] Search completed, ${searchResults.text.length} characters, ${searchResults.citations.length} citations`,
      );

      return {
        text: searchResults.text,
        citations: searchResults.citations,
      };
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

    // No agent-backed model in this deployment — the Bing leg cannot run.
    // Degrade to the feed alone (no interim emission: the result IS final).
    if (!params.model) {
      console.warn(
        '[WebSearchTool] Combined search without an agent-backed model; using news feed only',
      );
      const entries = await fetchGoogleNewsHeadlines(queries, feedOptions);
      return buildNewsResult(entries, label);
    }

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

    const bingSettled = await this.agentChatService
      .executeWebSearchTool({
        searchQuery: params.searchQuery,
        model: params.model,
        user: params.user,
        resultCount: params.resultCount,
        freshness: params.freshness,
        onActivity: params.onActivity,
      })
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
      return { text: bing.text, citations: bing.citations };
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
      return { text: bing.text, citations: bing.citations };
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
    };
  }
}
