import {
  countTokens,
  encodeText,
} from '@/lib/utils/server/tiktoken/tiktokenCache';

/**
 * Token-capped truncation for workflow inputs (reference documents, source
 * material). Keeps prompts inside model budgets with an explicit marker so
 * the model knows material was cut.
 */
export async function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): Promise<{ text: string; truncated: boolean; tokens: number }> {
  const tokens = await countTokens(text);
  if (tokens <= maxTokens) {
    return { text, truncated: false, tokens };
  }

  // Binary-search a character cut point that fits the budget. Encoding the
  // whole text once and slicing tokens would be exact, but decode round-trips
  // can split multi-byte graphemes; character search keeps the text valid.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);
    const candidateTokens = await countTokens(candidate);
    if (candidateTokens <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const truncatedText = `${text.slice(0, low)}\n\n[…truncated…]`;
  return { text: truncatedText, truncated: true, tokens: maxTokens };
}

/** Rough token count for pre-flight checks (exact via tiktoken). */
export async function estimateTokens(text: string): Promise<number> {
  return countTokens(text);
}

export { encodeText };
