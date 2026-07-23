export interface ParsedMessage {
  thinking?: string;
  content: string;
  /**
   * True when the text ends inside an UNCLOSED think block (streaming:
   * the model is still reasoning). Only reported with `includeUnclosed`.
   */
  thinkingInProgress?: boolean;
}

export interface ParseThinkingOptions {
  /**
   * Also treat a trailing UNCLOSED `<think>` block as thinking. Used on
   * the streaming render path so in-progress reasoning shows inside the
   * ThinkingBlock instead of leaking into the message body as raw text.
   * Keep OFF for persisted/history parsing, where an unclosed tag is more
   * likely literal prose than a live stream.
   */
  includeUnclosed?: boolean;
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
export function parseThinkingContent(
  text: string,
  options?: ParseThinkingOptions,
): ParsedMessage {
  if (!text || typeof text !== 'string') {
    return { content: text };
  }

  // Regex to match thinking tags (case-insensitive)
  // Matches: <think>...</think> or <thinking>...</thinking>
  const thinkingRegex = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

  const matches = [...text.matchAll(thinkingRegex)];

  // Extract all thinking blocks
  const thinkingBlocks = matches.map((match) => match[1].trim());

  // Remove closed thinking blocks from content
  let content = matches.length > 0 ? text.replace(thinkingRegex, '') : text;
  let thinkingInProgress = false;

  // Streaming: a trailing open tag without its close means the model is
  // mid-reasoning — everything after the tag is thinking, not body text.
  if (options?.includeUnclosed) {
    const openMatch = content.match(/<think(?:ing)?>/i);
    if (openMatch && openMatch.index !== undefined) {
      const inProgress = content
        .slice(openMatch.index + openMatch[0].length)
        .trim();
      if (inProgress) {
        thinkingBlocks.push(inProgress);
      }
      content = content.slice(0, openMatch.index);
      thinkingInProgress = true;
    }
  }

  if (thinkingBlocks.length === 0 && !thinkingInProgress) {
    return { content: text };
  }

  // Combine multiple thinking blocks with separators
  const thinking = thinkingBlocks.join('\n\n---\n\n');

  return {
    thinking: thinking || undefined,
    content: content.trim(),
    thinkingInProgress,
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
