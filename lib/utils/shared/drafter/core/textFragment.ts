/**
 * "Open source" links that land on the passage.
 *
 * A text fragment (`#:~:text=`) makes the browser scroll to and highlight the
 * quoted words on the original page. Browsers without support ignore the
 * directive and simply open the page, so the link is always safe to offer.
 */
import { DraftSource } from '@/types/drafter';

/** Above this many words the `start,end` form is more robust than one run. */
const RANGE_FORM_WORDS = 10;
const EDGE_WORDS = 5;

/**
 * Percent-encodes a text directive term. `-` must be escaped as well: in a
 * directive it separates the optional prefix and suffix from the match.
 */
function encodeTerm(term: string): string {
  return encodeURIComponent(term).replace(/-/gu, '%2D');
}

export function buildTextFragment(excerpt: string): string | null {
  const words = excerpt.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return null;
  if (words.length <= RANGE_FORM_WORDS) {
    return `:~:text=${encodeTerm(words.join(' '))}`;
  }
  const start = words.slice(0, EDGE_WORDS).join(' ');
  const end = words.slice(-EDGE_WORDS).join(' ');
  return `:~:text=${encodeTerm(start)},${encodeTerm(end)}`;
}

/** The page address with a fragment for `excerpt`; null for non-web URLs. */
export function buildTextFragmentUrl(
  url: string,
  excerpt: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const fragment = buildTextFragment(excerpt);
  if (!fragment) return parsed.toString();
  // An existing anchor is kept; the directive is appended after it.
  const hash = parsed.hash.replace(/^#/u, '').split(':~:')[0];
  parsed.hash = '';
  return `${parsed.toString()}#${hash}${fragment}`;
}

export interface SourceLink {
  href: string;
  /** True when the link lands on the passage, not just on the page. */
  atPassage: boolean;
  host: string;
}

/**
 * Where "Open source" goes for a source, or null when the source has no web
 * address (an uploaded file or a note opens in the in-app viewer instead).
 */
export function sourceLinkFor(
  source: DraftSource,
  excerpt: string,
): SourceLink | null {
  const address = source.url;
  if (!address) return null;
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }
  // `new URL` accepts `javascript:` and `data:` too. Every branch below
  // hands back something a person clicks, so only web addresses pass.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.host;
  // Office web viewers do not honour text fragments; link to the item only.
  // The PARSED form, so a newline the parser dropped is not in the href.
  if (source.kind === 'm365') {
    return { href: parsed.toString(), atPassage: false, host };
  }
  const href = buildTextFragmentUrl(address, excerpt);
  return href ? { href, atPassage: true, host } : null;
}
