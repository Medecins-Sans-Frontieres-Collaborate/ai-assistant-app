/**
 * Links in versions are placed by code, never written by the model: a URL
 * the model types can be mangled, and its cost against a character limit
 * (a flat 23 on X, its full length elsewhere) has to be known before the
 * text is written. The model is told how much room is taken; afterwards any
 * URL it wrote anyway is removed and the real ones are appended.
 */
import { BriefLink } from '@/types/drafter';

/** Where a kind of spec carries links. Supplied by its adapter. */
export interface LinkPolicy {
  /** False where links are not clickable (an image caption). */
  allowed: boolean;
  /** Which segment of a multi-segment version carries them. */
  position: 'first' | 'last';
  /** Characters one appended link costs under the spec's counting rule. */
  cost(url: string): number;
}

export const DEFAULT_LINK_POLICY: LinkPolicy = {
  allowed: true,
  position: 'last',
  cost: (url) => linkSuffix(url).length,
};

/** A link sits on its own line, a blank line below the text. */
export function linkSuffix(url: string): string {
  return `\n\n${url}`;
}

export interface LinkRange {
  start: number;
  end: number;
  url: string;
}

/** What may follow a link: the end, a space, or prose punctuation then one. */
const AFTER_LINK = /^[.,;:!?)\]}»”’]*(?:[\s<>"']|$)/u;

/**
 * Where the given links occur in `text`, as WHOLE links. A plain substring
 * search finds "https://msf.org" inside "https://msf.org/donate" and eats
 * half of the longer link, so an occurrence only counts when the link ends
 * there, and the longest link claims its ground first. This one matcher
 * serves stripping, protecting and checking, so they cannot disagree.
 */
export function linkRanges(
  text: string,
  links: ReadonlyArray<Pick<BriefLink, 'url'>>,
): LinkRange[] {
  const ranges: LinkRange[] = [];
  const urls = [...new Set(links.map((link) => link.url))]
    .filter((url) => url.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const url of urls) {
    let from = text.indexOf(url);
    while (from >= 0) {
      const end = from + url.length;
      const free = !ranges.some(
        (range) => from < range.end && end > range.start,
      );
      if (free && AFTER_LINK.test(text.slice(end, end + 12))) {
        ranges.push({ start: from, end, url });
      }
      from = text.indexOf(url, end);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Removes every occurrence of the given links, and the gaps they leave. */
export function stripLinks(text: string, links: BriefLink[]): string {
  let result = '';
  let cursor = 0;
  for (const range of linkRanges(text, links)) {
    result += text.slice(cursor, range.start);
    cursor = range.end;
  }
  result += text.slice(cursor);
  // Line by line: a `[ \t]+\n` pattern is quadratic on a long run of spaces.
  return result
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/gu, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Index of the segment that carries the links. */
export function linkSegmentIndex(count: number, policy: LinkPolicy): number {
  return policy.position === 'first' ? 0 : Math.max(0, count - 1);
}

/**
 * The segment texts with the links in place: stripped wherever the model or
 * an earlier pass left them, then appended to the one segment the policy
 * names, in the brief's order (the ask for donations last).
 */
export function placeLinks(
  texts: string[],
  links: BriefLink[],
  policy: LinkPolicy,
): string[] {
  if (links.length === 0) return texts;
  const clean = texts.map((text) => stripLinks(text, links));
  if (!policy.allowed || clean.length === 0) return clean;
  const at = linkSegmentIndex(clean.length, policy);
  return clean.map((text, index) =>
    index === at
      ? `${text}${links.map((link) => linkSuffix(link.url)).join('')}`.trim()
      : text,
  );
}

/** Characters the links take from the carrying segment's limit. */
export function linksCost(links: BriefLink[], policy: LinkPolicy): number {
  return policy.allowed
    ? links.reduce((sum, link) => sum + policy.cost(link.url), 0)
    : 0;
}
