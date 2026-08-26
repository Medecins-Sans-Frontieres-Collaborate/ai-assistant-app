import { htmlToMarkdown } from '@/lib/utils/shared/document/exportUtils';

/**
 * Elements whose text content must never reach the Markdown. Office apps put
 * a full document on the clipboard — `<style>` blocks of `mso-*` rules,
 * `<meta>`, `<xml>` islands and `<o:p>` paragraph markers — and turndown
 * would otherwise render the stylesheet as prose.
 */
const STRIP_SELECTOR = 'style, script, meta, link, title, xml, o\\:p';

/**
 * Converts clipboard `text/html` into Markdown suitable for the composer.
 * Returns an empty string when the input has no usable body, so callers can
 * treat "no HTML" and "HTML that converts to nothing" the same way.
 *
 * Browser-only: relies on `DOMParser`.
 */
export function clipboardHtmlToMarkdown(html: string): string {
  if (!html.trim() || typeof DOMParser === 'undefined') return '';

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(STRIP_SELECTOR).forEach((node) => node.remove());
    const body = doc.body?.innerHTML ?? '';
    if (!body.trim()) return '';
    return htmlToMarkdown(body).trim();
  } catch {
    return '';
  }
}
