export interface ParsedMessage {
  thinking?: string;
  content: string;
}

/**
 * Parses thinking content from message text.
 * Supports multiple formats:
 * - <think>...</think>
 * - <thinking>...</thinking>
 * - <Think>...</Think>
 * - <THINK>...</THINK>
 *
 * Returns both the thinking content and the remaining message content.
 */
export function parseThinkingContent(text: string): ParsedMessage {
  if (!text || typeof text !== 'string') {
    return { content: text };
  }

  // Regex to match thinking tags (case-insensitive)
  // Matches: <think>...</think> or <thinking>...</thinking>
  const thinkingRegex = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

  const matches = [...text.matchAll(thinkingRegex)];

  if (matches.length === 0) {
    return { content: text };
  }

  // Extract all thinking blocks
  const thinkingBlocks = matches.map((match) => match[1].trim());

  // Combine multiple thinking blocks with separators
  const thinking = thinkingBlocks.join('\n\n---\n\n');

  // Remove thinking blocks from content
  const content = text.replace(thinkingRegex, '').trim();

  return {
    thinking,
    content,
  };
}

/**
 * Extracts just the thinking content from text without modifying the original
 */
export function extractThinking(text: string): string | undefined {
  const parsed = parseThinkingContent(text);
  return parsed.thinking;
}

/**
 * Removes thinking tags from text, leaving only the content
 */
export function stripThinking(text: string): string {
  const parsed = parseThinkingContent(text);
  return parsed.content;
}
