import { AgentChatService } from '../AgentChatService';
import { Tool, ToolResult, WebSearchToolParams } from './Tool';

/**
 * WebSearchTool
 *
 * Executes web searches using AI Foundry agents.
 * Only the search query is sent to AI Foundry, not the full conversation,
 * preserving user privacy.
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
      return { text: '', citations: [] }; // Fail gracefully
    }
  }
}
