/**
 * Search Mode Configuration
 *
 * Controls how web search functionality is integrated into chat.
 */
export enum SearchMode {
  /**
   * No search functionality
   */
  OFF = 'off',

  /**
   * AI intelligently decides when to search (privacy-focused)
   * - ToolRouter analyzes the message
   * - Only searches when current info is needed
   * - Only search queries sent to AI Foundry
   */
  INTELLIGENT = 'intelligent',

  /**
   * Force search on every message (privacy-focused)
   * - Always performs web search
   * - Good for research tasks
   * - Only search queries sent to AI Foundry
   */
  ALWAYS = 'always',

  /**
   * Use AI Foundry agent directly (faster, less private)
   * - Full conversation sent to AI Foundry
   * - Faster response time
   * - Less privacy protection
   */
  AGENT = 'agent',
}

/**
 * Type guard for SearchMode
 */
export function isSearchMode(value: any): value is SearchMode {
  return Object.values(SearchMode).includes(value);
}
