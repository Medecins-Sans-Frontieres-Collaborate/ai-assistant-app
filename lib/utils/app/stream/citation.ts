import { Citation } from '@/types/rag';

import { parseMetadataFromContent } from '../metadata';

/**
 * Extracts citations from content using both marker and legacy formats
 * This is a wrapper around parseMetadataFromContent for backwards compatibility
 * @param content The text content to parse
 * @returns Object containing the cleaned text and extracted citations
 */
export const extractCitationsFromContent = (
  content: string,
): {
  text: string;
  citations: Citation[];
  extractionMethod: string;
} => {
  const parsed = parseMetadataFromContent(content);

  return {
    text: parsed.content,
    citations: parsed.citations,
    extractionMethod: parsed.extractionMethod,
  };
};
