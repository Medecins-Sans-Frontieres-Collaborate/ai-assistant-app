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

/**
 * Whether HTML represents a document with nothing in it.
 *
 * An empty Tiptap editor serializes to `<p></p>` rather than `''`, and near
 * variants (`<p><br></p>`, a stray `&nbsp;`) mean the same thing to a reader.
 * Comparing against a single literal would miss those, so this strips markup
 * and asks whether anything is left.
 *
 * Elements that carry meaning without carrying text — an image, a table, a
 * rule — count as content, or a document holding only a figure would be
 * mistaken for a blank one.
 */
export function isEmptyDocHtml(html: string): boolean {
  if (!html) return true;
  if (
    /<(img|table|hr|iframe|video|audio|figure|blockquote|pre|ul|ol|input)\b/i.test(
      html,
    )
  ) {
    return false;
  }
  const text = html
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '')
    .trim();
  return text === '';
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
