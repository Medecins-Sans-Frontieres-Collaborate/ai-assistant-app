import { normalizeMathDelimiters } from '@/lib/utils/shared/markdown/normalizeMath';

import { getDOMPurify } from './domPurify';

import { Marked, type TokenizerAndRendererExtension } from 'marked';

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
 * A display-math block: `$$` alone on a line, content, `$$` alone on a line.
 *
 * Deliberately NOT `$$...$$` on a single line — that form renders as INLINE
 * math in the on-screen renderer (Streamdown pins remark-math with
 * `singleDollarTextMath: false`, so `$$` is the only delimiter it has and a
 * one-line `$$x$$` mid-sentence is inline). Matching it here as a block would
 * make the export disagree with the screen, which is the whole defect this is
 * closing.
 */
const MATH_DISPLAY_RE =
  /^ {0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\$\$[ \t]*(?:\r?\n|$)/;

/** A display block can only OPEN on a line whose only content is `$$`. */
const MATH_DISPLAY_START_RE = /(^|\n)[ \t]{0,3}\$\$[ \t]*(?:\r?\n)/;

/** Inline math: `$$...$$` with no newline between the delimiters. */
const MATH_INLINE_RE = /^\$\$([^\n]*?)\$\$/;

/**
 * Escape TeX for an HTML text node. TeX is full of `<`, `>` and `&`
 * (`a < b`, the `&` alignment marker in `aligned`), and marked never sees
 * these characters as markdown because the extension consumes the whole span
 * as `raw` — so escaping is ours to do. Decoding the result (DOMPurify's
 * text-only strip, `htmlToPlainText`, turndown, html-to-docx) returns the
 * original TeX byte for byte, which is what the parity contract promises.
 */
function escapeTexForHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The exported form of a display block. `white-space: pre-wrap` keeps the line
 * structure of a multi-line `aligned` block readable in the .html and .pdf
 * exports, where the TeX is shown as text; it is inert in .docx/.txt/.md,
 * which read the text node and not the styling.
 */
function mathDisplayHtml(tex: string): string {
  return `<div class="math math-display" style="white-space:pre-wrap">$$\n${escapeTexForHtml(
    tex,
  )}\n$$</div>\n`;
}

const mathBlockExtension: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  // Tells marked where a paragraph must be cut short. Anchored to a full
  // `$$`-only line rather than a bare `indexOf('$$')`: the loose form would
  // cut a paragraph in half at an INLINE `$$x$$`, splitting a sentence across
  // two <p> elements.
  start(src: string) {
    const match = MATH_DISPLAY_START_RE.exec(src);
    return match ? match.index + match[1].length : undefined;
  },
  tokenizer(src: string) {
    const match = MATH_DISPLAY_RE.exec(src);
    if (!match) return undefined;
    return { type: 'mathBlock', raw: match[0], text: match[1] };
  },
  renderer(token) {
    return mathDisplayHtml(token.text as string);
  },
};

const mathInlineExtension: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src: string) {
    const index = src.indexOf('$$');
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string) {
    const match = MATH_INLINE_RE.exec(src);
    if (!match) return undefined;
    return { type: 'mathInline', raw: match[0], text: match[1] };
  },
  renderer(token) {
    return `<span class="math math-inline">$$${escapeTexForHtml(
      token.text as string,
    )}$$</span>`;
  },
};

/**
 * A private marked instance. `marked.use()` mutates the SHARED singleton, and
 * these extensions must not leak into any other consumer of `marked`.
 */
const markedWithMath = new Marked({ gfm: true, breaks: true }).use({
  extensions: [mathBlockExtension, mathInlineExtension],
  renderer: {
    /**
     * A ```` ```math ```` fence is DISPLAY MATH on screen (remark-math claims
     * that language), so it has to be display math here too or the export
     * disagrees with the message it came from. ```` ```latex ```` and
     * ```` ```tex ```` deliberately stay code blocks in both renderers: asking
     * for a `latex` fence is asking to SEE the source.
     *
     * Returning `false` hands the token back to marked's default renderer.
     */
    code(token) {
      if ((token.lang ?? '').trim().toLowerCase() !== 'math') return false;
      return mathDisplayHtml(token.text);
    },
  },
});

/**
 * Convert markdown to HTML.
 *
 * ## The export math contract (issue #121, C6)
 *
 * On screen, math renders through Streamdown → remark-math → KaTeX. This
 * function is the choke point for every EXPORT (.docx, .pdf, .html, .txt, and
 * the TipTap document editor), and it runs on bare `marked`, which has no
 * concept of math. Left alone the two renderers disagree: an equation on
 * screen arrives in the downloaded Word file as `<p>$$<br>\frac{a}{b}<br>$$</p>`
 * — the `breaks: true` option shreds a multi-line block with `<br>`s, and
 * `\[ ... \]` is worse still, because marked eats the backslashes as markdown
 * escapes and the delimiters are gone for good.
 *
 * What this promises, and what the conformance harness asserts:
 *
 * 1. Math is NORMALIZED first (`normalizeMathDelimiters`), so `\[...\]` and
 *    `\(...\)` are converted to dollar delimiters before marked can destroy
 *    them, and a display block is put on its own lines. Idempotent, so callers
 *    may normalize too — `MessageDownloadMenu` does, because the `.md` export
 *    never reaches this function.
 * 2. A display block becomes `<div class="math math-display">` and inline math
 *    becomes `<span class="math math-inline">`, each containing the TeX
 *    **including its `$$` delimiters**, verbatim. No `<br>` is inserted, no
 *    backslash is consumed, and the text survives HTML-entity decoding
 *    unchanged.
 * 3. Therefore: for any math region, the exported document's plain text equals
 *    that region of the normalized markdown character for character. The
 *    .docx / .txt / .html / .pdf exports and the .md export carry the same
 *    bytes, and a reader can paste them into any TeX-aware tool.
 *
 * This is a DELIBERATE, DECLARED DOWNGRADE, not an oversight. It is not
 * typeset math. We do not render KaTeX here, because four of the five export
 * targets would immediately throw the result away or mangle it: `html-to-docx`
 * has no OMML support and would turn KaTeX's span soup into garbage, the
 * .txt path strips every tag, .md never reaches this function, and the .html
 * file is opened with no `katex.min.css` to style it. Typeset output is only
 * worth building for the PDF path (html2pdf rasterizes inside the live
 * document, where KaTeX's CSS is already loaded) and that is a later tier.
 *
 * Single-`$` math is deliberately NOT recognised, because the on-screen
 * renderer does not recognise it either — recognising it here would break
 * parity in the other direction and would swallow the span between two
 * currency amounts ("$5,000 for supplies and $12,000 for staff"). Parity is
 * the rule, not "as much math as possible": whatever delimiter the normalizer
 * settles on, this function claims exactly the ones the screen claims.
 */
export function markdownToHtml(markdown: string): string {
  try {
    return markedWithMath.parse(normalizeMathDelimiters(markdown)) as string;
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
