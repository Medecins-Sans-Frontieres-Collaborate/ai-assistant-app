/**
 * Rough token estimation for back-calculating emissions of historical chats.
 *
 * Pure + shared (no server-only imports). Stored messages never recorded real
 * token counts, so pre-tracking usage is approximated from message text with a
 * chars/4 heuristic. The server's real tokenizer (tiktoken) is WASM and
 * server-only — shipping it to the client to refine an estimate whose emissions
 * math is itself order-of-magnitude would be unjustified weight.
 *
 * Known undercounts (accepted, since estimates are framed as such in the UI):
 * file/image payloads contribute no text, and non-English scripts often run
 * fewer chars per token than 4.
 */
import { Message } from '@/types/chat';

/** Rough English/code average for BPE tokenizers; heuristic on purpose. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimates the tokens of one stored message: all text parts of `content`,
 * plus `thinking` when present (reasoning text was real completion tokens).
 */
export function estimateMessageTokens(
  content: Message['content'],
  thinking?: string,
): number {
  let chars = 0;
  if (typeof content === 'string') {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') chars += part.text?.length ?? 0;
    }
  } else if (content?.type === 'text') {
    chars = content.text?.length ?? 0;
  }
  chars += thinking?.length ?? 0;
  return chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}
