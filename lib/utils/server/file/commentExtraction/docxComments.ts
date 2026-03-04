import type { CommentExtractionResult, DocumentComment } from '.';
import { OFFICE_XML_PARSER_OPTIONS } from './constants';

import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

/**
 * XML structure for DOCX comments.xml file.
 * The w:comment elements contain author, date, id attributes and w:t text nodes.
 */
interface DocxCommentsXml {
  'w:comments'?: {
    'w:comment'?: DocxComment | DocxComment[];
  };
}

interface DocxComment {
  '@_w:id': string;
  '@_w:author': string;
  '@_w:date'?: string;
  'w:p'?: DocxParagraph | DocxParagraph[];
}

interface DocxParagraph {
  'w:r'?: DocxRun | DocxRun[];
}

interface DocxRun {
  'w:t'?: string | { '#text': string };
}

/**
 * Extracts text content from a DOCX comment's paragraph structure.
 * Comments can have nested paragraphs (w:p) containing runs (w:r) with text (w:t).
 *
 * @param comment - The parsed DOCX comment object
 * @returns The concatenated text content of the comment
 */
function extractCommentText(comment: DocxComment): string {
  const paragraphs = comment['w:p'];
  if (!paragraphs) {
    return '';
  }

  const paragraphArray = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
  const textParts: string[] = [];

  for (const paragraph of paragraphArray) {
    const runs = paragraph['w:r'];
    if (!runs) continue;

    const runArray = Array.isArray(runs) ? runs : [runs];
    for (const run of runArray) {
      const textNode = run['w:t'];
      if (textNode) {
        const text =
          typeof textNode === 'string' ? textNode : textNode['#text'] || '';
        textParts.push(text);
      }
    }
  }

  return textParts.join('');
}

/**
 * Extracts comments from a DOCX (Word) document.
 *
 * DOCX files are ZIP archives containing XML files. Comments are stored in
 * `word/comments.xml` with the following structure:
 * - w:comments (root element)
 *   - w:comment (each comment)
 *     - @w:id (comment ID)
 *     - @w:author (author name)
 *     - @w:date (ISO date string)
 *     - w:p (paragraphs containing text)
 *       - w:r (runs)
 *         - w:t (text content)
 *
 * @param buffer - The DOCX file content as a Buffer
 * @returns Promise resolving to extraction result with comments array
 */
export async function extractDocxComments(
  buffer: Buffer,
): Promise<CommentExtractionResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const commentsFile = zip.file('word/comments.xml');

    if (!commentsFile) {
      // No comments file means document has no comments
      return { comments: [] };
    }

    const commentsXml = await commentsFile.async('string');

    const parser = new XMLParser(OFFICE_XML_PARSER_OPTIONS);

    const parsed: DocxCommentsXml = parser.parse(commentsXml);
    const commentsRoot = parsed['w:comments'];

    if (!commentsRoot || !commentsRoot['w:comment']) {
      return { comments: [] };
    }

    const rawComments = commentsRoot['w:comment'];
    const commentArray = Array.isArray(rawComments)
      ? rawComments
      : [rawComments];

    const comments: DocumentComment[] = commentArray.map((comment) => ({
      id: comment['@_w:id'] || 'unknown',
      author: comment['@_w:author'] || 'Unknown',
      date: comment['@_w:date'],
      text: extractCommentText(comment),
    }));

    return { comments };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    console.warn('[extractDocxComments] Failed to extract comments:', message);
    return {
      comments: [],
      error: `Failed to extract DOCX comments: ${message}`,
    };
  }
}
