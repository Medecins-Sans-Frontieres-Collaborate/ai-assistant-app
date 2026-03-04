import type { X2jOptions } from 'fast-xml-parser';

/**
 * Shared XMLParser configuration for parsing Office Open XML documents.
 *
 * This configuration is used by all comment extractors (DOCX, XLSX, PPTX)
 * to ensure consistent XML parsing behavior:
 * - `ignoreAttributes: false` - Preserve XML attributes (needed for IDs, refs, dates)
 * - `attributeNamePrefix: '@_'` - Prefix attributes to distinguish from child elements
 * - `textNodeName: '#text'` - Name for text content nodes
 */
export const OFFICE_XML_PARSER_OPTIONS: Partial<X2jOptions> = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
} as const;
