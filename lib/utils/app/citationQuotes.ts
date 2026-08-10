import { Citation } from '@/types/rag';

/**
 * Claim-level citation quotes (M365 agents, Wikipedia model): the model
 * emits a quote per cited source; each is displayed ONLY if it appears
 * verbatim in the retrieved chunk it claims to come from. Verification is
 * a normalized substring check — tolerant of whitespace and typographic
 * quote/dash variance introduced by generation, strict about words.
 */

const MIN_QUOTE_CHARS = 10;
const MAX_QUOTE_CHARS = 600;

/** Normalizes typography + whitespace so verbatim quotes compare equal. */
export function normalizeForQuoteMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/­/g, '') // soft hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Applies verified model quotes onto citations. For each citation number
 * with both a model-claimed quote and a source chunk, the quote replaces
 * the citation's (extractive-caption) quote only when it verifies; failed
 * or missing verification keeps the existing quote untouched.
 */
export function applyClaimQuotes(
  citations: Citation[],
  modelQuotes: Record<string, string> | null | undefined,
  quoteSources: Record<string, string> | null | undefined,
): Citation[] {
  if (!modelQuotes || !quoteSources) return citations;
  return citations.map((citation) => {
    const claimed = modelQuotes[String(citation.number)];
    const source = quoteSources[String(citation.number)];
    if (!claimed || !source) return citation;
    const trimmed = claimed.trim();
    if (trimmed.length < MIN_QUOTE_CHARS || trimmed.length > MAX_QUOTE_CHARS) {
      return citation;
    }
    if (
      !normalizeForQuoteMatch(source).includes(normalizeForQuoteMatch(trimmed))
    ) {
      return citation;
    }
    return { ...citation, quote: trimmed };
  });
}
