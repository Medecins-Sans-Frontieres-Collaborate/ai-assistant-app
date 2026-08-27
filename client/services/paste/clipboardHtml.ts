import { getDOMPurify } from '@/lib/utils/shared/document/domPurify';
import { htmlToMarkdown } from '@/lib/utils/shared/document/exportUtils';

/**
 * Elements whose text content must never reach the Markdown. Office apps put
 * a full document on the clipboard — `<style>` blocks of `mso-*` rules,
 * `<meta>`, `<xml>` islands and `<o:p>` paragraph markers — and turndown
 * would otherwise render the stylesheet as prose. DOMPurify keeps `<style>`
 * by default, so this pass runs after sanitizing.
 */
const STRIP_SELECTOR = 'style, script, meta, link, title, xml, o\\:p';

/**
 * Converts clipboard `text/html` into Markdown suitable for the composer.
 * Resolves to an empty string when the input has no usable body, so callers
 * can treat "no HTML" and "HTML that converts to nothing" the same way.
 *
 * The clipboard is attacker-influenceable — any page can write arbitrary
 * HTML to it during a copy — so the markup is sanitized with DOMPurify
 * before it is parsed. The parse itself uses an inert `DOMParser` document
 * (no script execution, no resource fetching) and nothing from it is ever
 * mounted; the only output is Markdown text.
 *
 * Browser-only: relies on `DOMParser`.
 */
export async function clipboardHtmlToMarkdown(html: string): Promise<string> {
  if (!html.trim() || typeof DOMParser === 'undefined') return '';

  try {
    const purify = await getDOMPurify();
    const safe = purify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'link', 'meta', 'title'],
      FORBID_ATTR: ['style', 'class', 'id'],
    });
    if (!safe.trim()) return '';

    const doc = new DOMParser().parseFromString(safe, 'text/html');
    doc.querySelectorAll(STRIP_SELECTOR).forEach((node) => node.remove());
    const body = doc.body?.innerHTML ?? '';
    if (!body.trim()) return '';
    return htmlToMarkdown(body).trim();
  } catch {
    return '';
  }
}
