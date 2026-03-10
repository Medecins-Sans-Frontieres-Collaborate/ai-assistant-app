import type { CommentExtractionResult, DocumentComment } from '.';
import { OFFICE_XML_PARSER_OPTIONS } from './constants';

import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

/**
 * XML structure for legacy Excel comments (xl/comments*.xml).
 * Each comment has a reference to a cell and text content.
 */
interface XlsxCommentsXml {
  comments?: {
    authors?: {
      author?: string | string[];
    };
    commentList?: {
      comment?: XlsxLegacyComment | XlsxLegacyComment[];
    };
  };
}

interface XlsxLegacyComment {
  '@_ref': string; // Cell reference like "A1", "B5"
  '@_authorId': string;
  text?: {
    r?: XlsxTextRun | XlsxTextRun[];
    t?: string;
  };
}

interface XlsxTextRun {
  t?: string;
}

/**
 * XML structure for modern threaded comments (xl/threadedComments*.xml).
 * These are the newer comment format introduced in Excel 2019+.
 */
interface XlsxThreadedCommentsXml {
  ThreadedComments?: {
    threadedComment?: XlsxThreadedComment | XlsxThreadedComment[];
  };
}

interface XlsxThreadedComment {
  '@_ref': string; // Cell reference
  '@_personId'?: string;
  '@_id': string;
  '@_dT'?: string; // ISO date
  text?: string;
}

/**
 * XML structure for person list (xl/persons/person.xml).
 * Maps person IDs to display names for threaded comments.
 */
interface XlsxPersonsXml {
  personList?: {
    person?: XlsxPerson | XlsxPerson[];
  };
}

interface XlsxPerson {
  '@_displayName': string;
  '@_id': string;
}

/**
 * Extracts text content from a legacy Excel comment.
 *
 * @param comment - The parsed comment object
 * @returns The text content of the comment
 */
function extractLegacyCommentText(comment: XlsxLegacyComment): string {
  if (!comment.text) {
    return '';
  }

  // Simple text node
  if (comment.text.t) {
    return comment.text.t;
  }

  // Rich text with runs
  if (comment.text.r) {
    const runs = Array.isArray(comment.text.r)
      ? comment.text.r
      : [comment.text.r];
    return runs
      .map((run) => run.t || '')
      .filter(Boolean)
      .join('');
  }

  return '';
}

/**
 * Extracts comments from an XLSX (Excel) document.
 *
 * Excel supports two comment formats:
 * 1. Legacy comments: Stored in `xl/comments*.xml` files (one per sheet)
 *    - Authors listed in separate section
 *    - Comments reference cells and author IDs
 *
 * 2. Threaded comments: Stored in `xl/threadedComments*.xml` (Excel 2019+)
 *    - Person info stored in `xl/persons/person.xml`
 *    - Supports reply threads
 *
 * This function extracts both formats and merges them.
 *
 * @param buffer - The XLSX file content as a Buffer
 * @returns Promise resolving to extraction result with comments array
 */
export async function extractXlsxComments(
  buffer: Buffer,
): Promise<CommentExtractionResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const comments: DocumentComment[] = [];
    let commentIndex = 0;

    const parser = new XMLParser(OFFICE_XML_PARSER_OPTIONS);

    // Extract legacy comments from xl/comments*.xml files
    const commentFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('xl/comments') && name.endsWith('.xml'),
    );

    for (const fileName of commentFiles) {
      const file = zip.file(fileName);
      if (!file) continue;

      const xml = await file.async('string');
      const parsed: XlsxCommentsXml = parser.parse(xml);

      if (!parsed.comments?.commentList?.comment) continue;

      // Build author map
      const authorMap: Map<string, string> = new Map();
      if (parsed.comments.authors?.author) {
        const authors = Array.isArray(parsed.comments.authors.author)
          ? parsed.comments.authors.author
          : [parsed.comments.authors.author];
        authors.forEach((author, index) => {
          authorMap.set(String(index), author);
        });
      }

      const rawComments = parsed.comments.commentList.comment;
      const commentArray = Array.isArray(rawComments)
        ? rawComments
        : [rawComments];

      for (const comment of commentArray) {
        const authorId = comment['@_authorId'];
        const author = authorMap.get(authorId) || 'Unknown';
        const text = extractLegacyCommentText(comment);

        if (text) {
          comments.push({
            id: String(++commentIndex),
            author,
            text,
            location: `Cell ${comment['@_ref']}`,
          });
        }
      }
    }

    // Extract threaded comments from xl/threadedComments*.xml files
    const threadedFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('xl/threadedComments') && name.endsWith('.xml'),
    );

    // Build person map for threaded comments
    const personMap: Map<string, string> = new Map();
    const personsFile = zip.file('xl/persons/person.xml');
    if (personsFile) {
      const personsXml = await personsFile.async('string');
      const parsedPersons: XlsxPersonsXml = parser.parse(personsXml);

      if (parsedPersons.personList?.person) {
        const persons = Array.isArray(parsedPersons.personList.person)
          ? parsedPersons.personList.person
          : [parsedPersons.personList.person];

        for (const person of persons) {
          personMap.set(person['@_id'], person['@_displayName']);
        }
      }
    }

    for (const fileName of threadedFiles) {
      const file = zip.file(fileName);
      if (!file) continue;

      const xml = await file.async('string');
      const parsed: XlsxThreadedCommentsXml = parser.parse(xml);

      if (!parsed.ThreadedComments?.threadedComment) continue;

      const rawComments = parsed.ThreadedComments.threadedComment;
      const commentArray = Array.isArray(rawComments)
        ? rawComments
        : [rawComments];

      for (const comment of commentArray) {
        const personId = comment['@_personId'];
        const author = personId
          ? personMap.get(personId) || 'Unknown'
          : 'Unknown';
        const text = comment.text || '';

        if (text) {
          comments.push({
            id: comment['@_id'] || String(++commentIndex),
            author,
            date: comment['@_dT'],
            text,
            location: `Cell ${comment['@_ref']}`,
          });
        }
      }
    }

    return { comments };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    console.warn('[extractXlsxComments] Failed to extract comments:', message);
    return {
      comments: [],
      error: `Failed to extract XLSX comments: ${message}`,
    };
  }
}
