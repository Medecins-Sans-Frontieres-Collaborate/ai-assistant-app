/**
 * Interface representing a prompt match result
 */
export interface PromptMatch {
  /** Whether a prompt pattern was found */
  matched: boolean;
  /** The search term extracted from the pattern (without the /) */
  searchTerm: string;
}

/**
 * Finds a prompt command pattern in text (e.g., "/promptname")
 * Matches a forward slash followed by word characters at the end of the string
 *
 * @param text - The text to search for prompt patterns
 * @returns PromptMatch object with match status and search term
 *
 * @example
 * findPromptMatch('Hello /email')
 * // Returns: { matched: true, searchTerm: 'email' }
 *
 * @example
 * findPromptMatch('Hello world')
 * // Returns: { matched: false, searchTerm: '' }
 */
export const findPromptMatch = (text: string): PromptMatch => {
  const match = /\/\w*$/.exec(text);

  if (match) {
    return {
      matched: true,
      searchTerm: match[0].slice(1), // Remove the leading /
    };
  }

  return {
    matched: false,
    searchTerm: '',
  };
};

/**
 * Updates prompt list visibility based on text input
 * Returns whether the prompt list should be shown and the search term
 *
 * @param text - The current text input
 * @returns Object with showList flag and inputValue for filtering
 */
export const updatePromptListVisibility = (
  text: string,
): { showList: boolean; inputValue: string } => {
  const matchResult = findPromptMatch(text);

  return {
    showList: matchResult.matched,
    inputValue: matchResult.searchTerm,
  };
};
