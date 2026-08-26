import { isLikelyUrl } from '@/client/services/url/urlFetchClient';

/**
 * Everything worth keeping from a paste event. The `DataTransfer` is only
 * readable while the event is dispatching, so the hook copies it into this
 * plain object before the chooser opens.
 */
export interface CapturedPaste {
  /** `text/plain`, or empty. */
  text: string;
  /**
   * Markdown converted from `text/html`, or empty when the clipboard had no
   * HTML or the conversion produced nothing usable.
   */
  markdown: string;
  /** Image items, already renamed for the upload pipeline. */
  imageFiles: File[];
}

export type PasteOptionId =
  | 'text'
  | 'markdown'
  | 'attachText'
  | 'attachMarkdown'
  | 'image'
  | 'link';

export type PasteOptionSection = 'insert' | 'attach';

export interface PasteOption {
  id: PasteOptionId;
  section: PasteOptionSection;
  /** Number of files for the image option; undefined elsewhere. */
  count?: number;
}

/** Collapses whitespace so a Markdown/plain comparison ignores wrapping. */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Whether the Markdown conversion carries anything the plain text does not.
 * Word, Excel and browsers always put `text/html` next to `text/plain`, but
 * for an unformatted sentence the two are the same words — offering a
 * "formatted" option then would be a distinction without a difference.
 */
export function hasDistinctMarkdown(paste: CapturedPaste): boolean {
  const md = paste.markdown.trim();
  if (!md) return false;
  return normalize(md) !== normalize(paste.text);
}

/**
 * The paste options this clipboard actually supports, in display order.
 * Pure so the availability rules can be tested without a DOM.
 */
export function getPasteOptions(paste: CapturedPaste): PasteOption[] {
  const options: PasteOption[] = [];
  const hasText = paste.text.trim().length > 0;
  const hasMarkdown = hasDistinctMarkdown(paste);

  if (hasText) options.push({ id: 'text', section: 'insert' });
  if (hasMarkdown) options.push({ id: 'markdown', section: 'insert' });

  if (hasText) options.push({ id: 'attachText', section: 'attach' });
  if (hasMarkdown) options.push({ id: 'attachMarkdown', section: 'attach' });
  if (paste.imageFiles.length > 0) {
    options.push({
      id: 'image',
      section: 'attach',
      count: paste.imageFiles.length,
    });
  }
  if (hasText && isLikelyUrl(paste.text)) {
    options.push({ id: 'link', section: 'attach' });
  }

  return options;
}
