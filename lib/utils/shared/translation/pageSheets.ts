/**
 * Preparing a document's pages for display as page sheets.
 *
 * Display only: nothing here changes the text that is translated. Page
 * numbers follow the convention in `pageBatches.ts`.
 */
import { SourcePage } from '@/lib/utils/shared/translation/pageBatches';

/**
 * Share of a document's pages that must carry the same page counter before
 * it is treated as a running header or footer rather than content.
 */
export const PAGE_COUNTER_MIN_SHARE = 0.5;

/** A counter seen on a single page proves nothing: at least this many. */
export const PAGE_COUNTER_MIN_PAGES = 2;

type CounterEdge = 'start' | 'end';

/**
 * Matches a page's own counter at one edge of its text: the page number, a
 * slash or short word, then the total ("3 / 409", "3 of 409", "3 von 409").
 * With `labelled`, a word must come first ("Page 3 / 409"). The named group
 * `key` is what pages must agree on: the total, and the label when asked.
 */
function counterPattern(
  page: number,
  edge: CounterEdge,
  labelled: boolean,
): RegExp {
  const label = labelled ? '(?<label>\\p{L}+)\\.?\\s*' : '';
  const counter = `${label}${page}\\s*(?:\\/|\\p{L}{1,4}\\s)\\s*(?<total>\\d+)`;
  return edge === 'start'
    ? new RegExp(`^\\s*${counter}(?!\\d)\\s*`, 'u')
    : new RegExp(`(?:^|\\s)${counter}\\s*$`, 'u');
}

/** What a page's counter must share with the others': label and total. */
function counterKey(match: RegExpMatchArray | null): string | null {
  if (!match?.groups) return null;
  return `${match.groups.label ?? ''}|${match.groups.total}`;
}

/**
 * Finds the counter the pages agree on at one edge, if enough carry it.
 */
function sharedCounterKey(
  pages: SourcePage[],
  edge: CounterEdge,
  labelled: boolean,
): string | null {
  const lastPage = Math.max(...pages.map((page) => page.page));
  const votes = new Map<string, number>();
  for (const page of pages) {
    const match = page.text.match(counterPattern(page.page, edge, labelled));
    const key = counterKey(match);
    // A total below a page number that exists is not a page count.
    if (key === null || Number(match?.groups?.total) < lastPage) continue;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const needed = Math.max(
    PAGE_COUNTER_MIN_PAGES,
    Math.ceil(pages.length * PAGE_COUNTER_MIN_SHARE),
  );
  for (const [key, count] of votes) if (count >= needed) return key;
  return null;
}

/**
 * Removes each page's own printed counter ("Page 3 / 409") from the start
 * or end of its text, for display under a page label that already says it.
 *
 * A counter is removed only when it names the page it is on and at least
 * half the pages (and no fewer than two) carry one with the same total and
 * the same label, so a sentence that merely starts with numbers is left
 * alone.
 *
 * @param pages - All pages of the document, so the pattern can be judged
 *   across the whole file.
 * @returns The pages with counters removed; pages without one are unchanged.
 * @example
 * stripPageCounters([
 *   { page: 1, text: 'Page 1 / 2 Title' },
 *   { page: 2, text: 'Page 2 / 2 Body' },
 * ]); // [{ page: 1, text: 'Title' }, { page: 2, text: 'Body' }]
 */
export function stripPageCounters(pages: SourcePage[]): SourcePage[] {
  if (pages.length === 0) return pages;
  let result = pages;
  for (const edge of ['start', 'end'] as const) {
    // A label counts as part of the counter only when the pages share it
    // ("Page"); otherwise the word before the number is content.
    for (const labelled of [true, false]) {
      const shared = sharedCounterKey(result, edge, labelled);
      if (shared === null) continue;
      result = result.map((page) => {
        const match = page.text.match(
          counterPattern(page.page, edge, labelled),
        );
        if (!match || counterKey(match) !== shared) return page;
        const text =
          edge === 'start'
            ? page.text.slice(match[0].length)
            : page.text.slice(0, match.index);
        return { page: page.page, text: text.trim() };
      });
      break;
    }
  }
  return result;
}

/**
 * The page a jump to `wanted` lands on: that page, or the nearest page with
 * text when it has none.
 *
 * @param pages - Pages on display, in document order.
 * @param wanted - Page number asked for.
 * @returns A page number present in `pages`, or null when there are none.
 */
export function nearestPage(
  pages: SourcePage[],
  wanted: number,
): number | null {
  let nearest: number | null = null;
  for (const { page } of pages) {
    if (
      nearest === null ||
      Math.abs(page - wanted) < Math.abs(nearest - wanted)
    )
      nearest = page;
  }
  return nearest;
}
