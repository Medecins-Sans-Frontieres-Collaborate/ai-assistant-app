import { getDOMPurify } from './domPurify';

import { marked } from 'marked';

/**
 * Convert various document formats to HTML for TipTap editor
 */

export type SupportedFormat =
  | 'md'
  | 'txt'
  | 'html'
  | 'htm'
  | 'markdown'
  | 'pdf';

/**
 * Detect file format from extension
 */
export function detectFormat(fileName: string): SupportedFormat | null {
  const ext = fileName.split('.').pop()?.toLowerCase();

  const formatMap: Record<string, SupportedFormat> = {
    md: 'md',
    markdown: 'md',
    txt: 'txt',
    html: 'html',
    htm: 'html',
    pdf: 'pdf',
  };

  return ext && formatMap[ext] ? formatMap[ext] : null;
}

/** Entities that render as blank space and so do not count as content. */
const BLANK_ENTITIES = new Set([
  'nbsp',
  'ensp',
  'emsp',
  'thinsp',
  '#160',
  '#xa0',
  '#32',
]);

/** Elements that carry meaning without carrying any text. */
const CONTENT_BEARING_TAG =
  /<(img|table|hr|iframe|video|audio|figure|blockquote|pre|ul|ol|input)\b/i;

/**
 * Whether any non-whitespace character sits outside a tag.
 *
 * A SCANNER, deliberately not a strip-then-compare. Removing tags with
 * `replace(/<[^>]*>/g, '')` is the shape of an HTML sanitizer — CodeQL flags
 * it as one (js/incomplete-multi-character-sanitization), and correctly so in
 * general, since one pass over malformed nesting can reassemble `<script`.
 * Nothing here is sanitizing: the result is a boolean and no string derived
 * from the input is ever returned or rendered. Scanning says that plainly,
 * and handles malformed nesting without pretending to clean it.
 */
function hasVisibleText(html: string): boolean {
  let depth = 0;
  for (let i = 0; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '<') {
      depth += 1;
      continue;
    }
    if (ch === '>') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (ch === '&') {
      const end = html.indexOf(';', i);
      // Bounded: a bare '&' with no terminator is just a visible character.
      if (end === -1 || end - i > 10) return true;
      const name = html.slice(i + 1, end).toLowerCase();
      i = end;
      if (BLANK_ENTITIES.has(name)) continue;
      return true;
    }
    if (!/\s/.test(ch)) return true;
  }
  return false;
}

/**
 * Whether HTML represents a document with nothing in it.
 *
 * An empty Tiptap editor serializes to `<p></p>` rather than `''`, and near
 * variants (`<p><br></p>`, a stray `&nbsp;`) mean the same thing to a reader,
 * so this asks whether anything would actually show rather than comparing
 * against a literal.
 *
 * An image, a table or a rule counts as content, or a document holding only a
 * figure would be mistaken for a blank one.
 */
export function isEmptyDocHtml(html: string): boolean {
  if (!html) return true;
  if (CONTENT_BEARING_TAG.test(html)) return false;
  return !hasVisibleText(html);
}

/**
 * Convert markdown to HTML
 */
export function markdownToHtml(markdown: string): string {
  try {
    return marked.parse(markdown, {
      gfm: true, // GitHub Flavored Markdown
      breaks: true, // Convert \n to <br>
    }) as string;
  } catch (error) {
    console.error('Error converting markdown:', error);
    return `<p>${markdown}</p>`;
  }
}

/**
 * Convert plain text to HTML
 */
export function textToHtml(text: string): string {
  // Split by double newlines for paragraphs
  const paragraphs = text.split(/\n\n+/);

  return paragraphs
    .map((p) => {
      // Convert single newlines to <br>
      const withBreaks = p.replace(/\n/g, '<br>');
      return `<p>${withBreaks}</p>`;
    })
    .join('');
}

/**
 * Convert PDF to HTML by extracting text
 * Dynamically imports PDF.js to avoid SSR issues
 */
export async function pdfToHtml(pdfData: ArrayBuffer): Promise<string> {
  try {
    // Dynamic import to avoid SSR issues
    const pdfjsLib = await import('pdfjs-dist');

    // Configure PDF.js worker
    if (typeof window !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
    }

    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    const pdf = await loadingTask.promise;

    const textContents: string[] = [];

    // Extract text from each page
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Join text items with spaces
      const pageText = textContent.items.map((item: any) => item.str).join(' ');

      if (pageText.trim()) {
        textContents.push(`<h2>Page ${pageNum}</h2>`);
        textContents.push(textToHtml(pageText));
      }
    }

    return textContents.join('\n');
  } catch (error) {
    console.error('Error converting PDF:', error);
    throw new Error(
      'Failed to parse PDF. The file may be corrupted or password-protected.',
    );
  }
}

/**
 * Sanitize HTML using DOMPurify for security
 */
export async function sanitizeHtml(html: string): Promise<string> {
  const DOMPurify = await getDOMPurify();

  // Use DOMPurify for comprehensive sanitization
  return DOMPurify.sanitize(html, {
    // Allow common safe tags
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'code',
      'pre',
      'a',
      'img',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'div',
      'span',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id'],
    // Remove all scripts and event handlers
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  });
}

/**
 * Convert any supported format to HTML
 */
export async function convertToHtml(
  content: string,
  format: SupportedFormat,
): Promise<string> {
  switch (format) {
    case 'md':
    case 'markdown':
      return markdownToHtml(content);

    case 'txt':
      return textToHtml(content);

    case 'html':
    case 'htm':
      return await sanitizeHtml(content);

    default:
      // Fallback to text
      return textToHtml(content);
  }
}

/**
 * Extensions whose text arrives ALREADY CONVERTED TO MARKDOWN by the server
 * extraction pipeline (pandoc, in `lib/utils/server/file/fileHandling.ts`).
 *
 * The filename still says `.docx`, but the string in hand is markdown. Going
 * by extension alone sends it to `textToHtml`, which wraps pandoc's
 * `# Heading` and `**bold**` in a `<p>` verbatim — the import lands as one
 * grey slab with the syntax showing. These are checked separately from
 * `detectFormat`, which answers a different question (what the *file* is) and
 * is relied on elsewhere.
 */
const EXTRACTED_AS_MARKDOWN = new Set(['docx', 'odt', 'rtf', 'epub']);

/**
 * Auto-detect format and convert to HTML
 */
export async function autoConvertToHtml(
  content: string,
  fileName?: string,
): Promise<string> {
  if (!fileName) {
    // Try to detect if it's markdown by looking for markdown patterns
    if (content.match(/^#{1,6}\s|[*_]{1,2}[^*_]+[*_]{1,2}|\[.+\]\(.+\)|```/m)) {
      return markdownToHtml(content);
    }
    // Default to text
    return textToHtml(content);
  }

  const format = detectFormat(fileName);
  if (format) {
    return await convertToHtml(content, format);
  }

  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext && EXTRACTED_AS_MARKDOWN.has(ext)) {
    return markdownToHtml(content);
  }

  // Fallback to text
  return textToHtml(content);
}
