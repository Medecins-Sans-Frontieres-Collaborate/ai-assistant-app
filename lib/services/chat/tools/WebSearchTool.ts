import { AgentChatService } from '../AgentChatService';
import { Tool, ToolResult, WebSearchToolParams } from './Tool';
import { searchGoogleNews } from './googleNewsSearch';
import { searchNewsFanOut, searchNewsParallel } from './newsSearch';

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
        // the legs; see searchNewsFanOut).
        const fanOutQueries =
          (params.searchQueries?.length ?? 0) > 1
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
}
