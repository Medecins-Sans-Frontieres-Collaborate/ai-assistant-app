import type { CommentExtractionResult, DocumentComment } from '.';
import { OFFICE_XML_PARSER_OPTIONS } from './constants';

import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

/**
 * XML structure for PPTX comment authors (ppt/commentAuthors.xml).
 * Maps author IDs to names and initials.
 */
interface PptxCommentAuthorsXml {
  'p:cmAuthorLst'?: {
    'p:cmAuthor'?: PptxAuthor | PptxAuthor[];
  };
}

interface PptxAuthor {
  '@_id': string;
  '@_name': string;
  '@_initials'?: string;
}

/**
 * XML structure for PPTX comments (ppt/comments/comment*.xml).
 * Each file corresponds to a slide.
 */
interface PptxCommentsXml {
  'p:cmLst'?: {
    'p:cm'?: PptxComment | PptxComment[];
  };
}

interface PptxComment {
  '@_authorId': string;
  '@_dt'?: string; // ISO date
  '@_idx'?: string; // Comment index
  'p:text'?: string;
}

/**
 * Extracts the slide number from a comment file path.
 * Comment files are named like: ppt/comments/comment1.xml, comment2.xml, etc.
 * The number corresponds to the slide number.
 *
 * @param filePath - The path to the comment file
 * @returns The slide number, or undefined if not parseable
 */
function extractSlideNumber(filePath: string): number | undefined {
  const match = filePath.match(/comment(\d+)\.xml$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Extracts comments from a PPTX (PowerPoint) document.
 *
 * PPTX comment structure:
 * - `ppt/commentAuthors.xml`: Maps author IDs to names
 * - `ppt/comments/comment*.xml`: One file per slide with comments
 *
 * Each comment file corresponds to a slide (comment1.xml = slide 1, etc.)
 *
 * @param buffer - The PPTX file content as a Buffer
 * @returns Promise resolving to extraction result with comments array
 */
export async function extractPptxComments(
  buffer: Buffer,
): Promise<CommentExtractionResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const comments: DocumentComment[] = [];
    let commentIndex = 0;

    const parser = new XMLParser(OFFICE_XML_PARSER_OPTIONS);

    // Build author map from commentAuthors.xml
    const authorMap: Map<string, string> = new Map();
    const authorsFile = zip.file('ppt/commentAuthors.xml');

    if (authorsFile) {
      const authorsXml = await authorsFile.async('string');
      const parsed: PptxCommentAuthorsXml = parser.parse(authorsXml);

      if (parsed['p:cmAuthorLst']?.['p:cmAuthor']) {
        const authors = parsed['p:cmAuthorLst']['p:cmAuthor'];
        const authorArray = Array.isArray(authors) ? authors : [authors];

        for (const author of authorArray) {
          authorMap.set(author['@_id'], author['@_name']);
        }
      }
    }

    // Find all comment files in ppt/comments/
    const commentFiles = Object.keys(zip.files).filter(
      (name) =>
        name.startsWith('ppt/comments/comment') && name.endsWith('.xml'),
    );

    for (const fileName of commentFiles) {
      const file = zip.file(fileName);
      if (!file) continue;

      const slideNumber = extractSlideNumber(fileName);
      const xml = await file.async('string');
      const parsed: PptxCommentsXml = parser.parse(xml);

      if (!parsed['p:cmLst']?.['p:cm']) continue;

      const rawComments = parsed['p:cmLst']['p:cm'];
      const commentArray = Array.isArray(rawComments)
        ? rawComments
        : [rawComments];

      for (const comment of commentArray) {
        const authorId = comment['@_authorId'];
        const author = authorMap.get(authorId) || 'Unknown';
        const text = comment['p:text'] || '';

        if (text) {
          comments.push({
            id: comment['@_idx'] || String(++commentIndex),
            author,
            date: comment['@_dt'],
            text,
            location: slideNumber ? `Slide ${slideNumber}` : undefined,
          });
        }
      }
    }

    return { comments };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    console.warn('[extractPptxComments] Failed to extract comments:', message);
    return {
      comments: [],
      error: `Failed to extract PPTX comments: ${message}`,
    };
  }
}
