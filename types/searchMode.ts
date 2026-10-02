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
   * @deprecated Retired 2026-10: the "Agent" routing that sent the whole
   * conversation to a hand-made Foundry agent. Kept only so persisted
   * conversations and older clients still parse; read it through
   * normalizeSearchMode, which maps it to INTELLIGENT.
   */
  AGENT = 'agent',
}

/** A persisted or client-sent mode as it should be acted on today. */
export function normalizeSearchMode<T extends SearchMode | undefined>(
  mode: T,
): T {
  return (mode === SearchMode.AGENT ? SearchMode.INTELLIGENT : mode) as T;
}

/**
 * Type guard for SearchMode
 */
export function isSearchMode(value: any): value is SearchMode {
  return Object.values(SearchMode).includes(value);
}
