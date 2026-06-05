import { AgentChatService } from '../AgentChatService';
import { Tool, ToolResult, WebSearchToolParams } from './Tool';

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
    try {
      console.log(`[WebSearchTool] Executing search: "${params.searchQuery}"`);

      const searchResults = await this.agentChatService.executeWebSearchTool({
        searchQuery: params.searchQuery,
        model: params.model,
        user: params.user,
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
