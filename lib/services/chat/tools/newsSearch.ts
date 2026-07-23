/**
 * Parallel news search orchestrator (WEB_SEARCH_PROVIDER=news, the default).
 *
 * Fans the query out to GDELT and the Google News RSS feed CONCURRENTLY and
 * merges the results, so each source is the other's backup: if one feed
 * errors, times out, or returns nothing, the search still succeeds on the
 * other. When both return, results are interleaved (GDELT first — its URLs
 * are real publisher links needing no resolution) and deduplicated by URL
 * and normalized title, which also cross-checks coverage: a story both
 * feeds surface appears once.
 */
import { GdeltArticle, searchGdelt } from './gdeltSearch';
import {
  GoogleNewsSearchOptions,
  GoogleNewsSearchResult,
  decodeLegacyGoogleNewsUrl,
  fetchGoogleNewsItems,
} from './googleNewsSearch';

export type NewsSource = 'gdelt' | 'google-news';

interface NewsEntry {
  title: string;
  url: string;
  date: string;
  sourceName?: string;
  sourceUrl?: string;
  snippet?: string;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function gdeltEntries(articles: GdeltArticle[]): NewsEntry[] {
  return articles.map((article) => {
    const domain = article.domain.replace(/^www\./, '');
    return {
      title: article.title,
      url: article.url,
      date: article.date,
      ...(domain ? { sourceName: domain, sourceUrl: `https://${domain}` } : {}),
    };
  });
}

async function googleNewsEntries(
  query: string,
  options: GoogleNewsSearchOptions,
): Promise<NewsEntry[]> {
  const items = await fetchGoogleNewsItems(query, options);
  return items.map((item) => ({
    title: item.title || item.source || 'Untitled',
    // Free local decode only; new-format links stay as redirect links and
    // are upgraded client-side after render (see /api/search/resolve-links).
    url: decodeLegacyGoogleNewsUrl(item.link) ?? item.link,
    date: item.pubDate,
    ...(item.source ? { sourceName: item.source } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.snippet && item.snippet !== item.title
      ? { snippet: item.snippet }
      : {}),
  }));
}

/** Interleaves the source lists, deduplicating by URL and normalized title. */
export function mergeNewsEntries(
  lists: NewsEntry[][],
  cap: number,
): NewsEntry[] {
  const merged: NewsEntry[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const longest = Math.max(0, ...lists.map((list) => list.length));

  for (let rank = 0; rank < longest && merged.length < cap; rank++) {
    for (const list of lists) {
      if (merged.length >= cap) break;
      const entry = list[rank];
      if (!entry) continue;
      const titleKey = normalizeTitle(entry.title);
      if (seenUrls.has(entry.url) || (titleKey && seenTitles.has(titleKey))) {
        continue;
      }
      seenUrls.add(entry.url);
      if (titleKey) seenTitles.add(titleKey);
      merged.push(entry);
    }
  }
  return merged;
}

export interface NewsSearchStrategy {
  sources?: NewsSource[];
  /**
   * Deep (research-style) searches wait on EVERY source in parallel for
   * maximum coverage — worth GDELT's rate-limit queue (1 req/5s/IP) when
   * back-to-back searches stack up. Surface lookups take the fastest
   * source (Google News, instant) and touch the queued one only as a
   * backup when the fast feed fails or comes back empty.
   */
  deep?: boolean;
}

function runSource(
  source: NewsSource,
  query: string,
  options: GoogleNewsSearchOptions,
): Promise<NewsEntry[]> {
  return source === 'gdelt'
    ? searchGdelt(query, {
        resultCount: options.resultCount,
        freshness: options.freshness,
      }).then(gdeltEntries)
    : googleNewsEntries(query, options);
}

export async function searchNewsParallel(
  query: string,
  options: GoogleNewsSearchOptions,
  strategy: NewsSearchStrategy = {},
): Promise<GoogleNewsSearchResult & { providersUsed: NewsSource[] }> {
  const { deep = true } = strategy;
  let sources = strategy.sources ?? ['gdelt', 'google-news'];
  // Surface mode: query fast sources only; slow ones become the fallback
  // tier instead of a parallel leg.
  const fallbackSources: NewsSource[] = [];
  if (!deep && sources.length > 1 && sources.includes('gdelt')) {
    fallbackSources.push('gdelt');
    sources = sources.filter((source) => source !== 'gdelt');
  }

  const lists: NewsEntry[][] = [];
  const providersUsed: NewsSource[] = [];
  const failures: string[] = [];

  const runTier = async (tier: NewsSource[]) => {
    const settled = await Promise.allSettled(
      tier.map((source) => runSource(source, query, options)),
    );
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        if (result.value.length > 0) {
          lists.push(result.value);
          providersUsed.push(tier[idx]);
        }
      } else {
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failures.push(`${tier[idx]}: ${reason}`);
        console.warn(
          `[newsSearch] Provider ${tier[idx]} failed (continuing with others): ${reason}`,
        );
      }
    });
  };

  await runTier(sources);
  // Backup tier: only consulted when the fast tier produced nothing.
  if (lists.length === 0 && fallbackSources.length > 0) {
    console.log(
      `[newsSearch] Fast tier empty — falling back to: ${fallbackSources.join(', ')}`,
    );
    await runTier(fallbackSources);
  }

  // Every consulted provider errored (as opposed to returning empty
  // feeds) — surface it so the enricher's failure path runs rather than
  // the empty-result one.
  const consulted =
    lists.length === 0
      ? sources.length + fallbackSources.length
      : sources.length;
  if (lists.length === 0 && failures.length === consulted) {
    throw new Error(`All news providers failed — ${failures.join('; ')}`);
  }

  const entries = mergeNewsEntries(lists, options.resultCount);
  return { ...buildNewsResult(entries, `"${query}"`), providersUsed };
}

/** Formats merged entries as the digest + citations shape all providers share. */
function buildNewsResult(
  entries: NewsEntry[],
  queryLabel: string,
): GoogleNewsSearchResult {
  if (entries.length === 0) {
    return { text: '', citations: [] };
  }

  const citations = entries.map((entry, idx) => ({
    number: idx + 1,
    title: entry.title,
    url: entry.url,
    date: entry.date,
    ...(entry.sourceName ? { sourceName: entry.sourceName } : {}),
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
  }));

  const digest = entries
    .map((entry, idx) => {
      const meta = [entry.sourceName, entry.date].filter(Boolean).join(', ');
      return `[${idx + 1}] ${entry.title}${meta ? ` (${meta})` : ''}${
        entry.snippet ? `\n${entry.snippet}` : ''
      }`;
    })
    .join('\n\n');

  const text =
    `Recent news results for ${queryLabel} (headlines and snippets — synthesize an answer from these and cite by number):\n\n` +
    digest;

  return { text, citations };
}

/**
 * Multi-aspect fan-out: one Google News leg PER QUERY, all concurrent,
 * merged with the same interleave/dedupe as the provider merge — so each
 * aspect gets fair representation in the capped result. Google News only:
 * its feed answers in well under a second and tolerates parallel requests,
 * whereas GDELT's 1-request/5s spacing queue would serialize the legs into
 * tens of seconds of latency.
 */
export async function searchNewsFanOut(
  queries: string[],
  options: GoogleNewsSearchOptions,
): Promise<GoogleNewsSearchResult & { providersUsed: NewsSource[] }> {
  const capped = queries.slice(0, 5);
  // Fetch a per-query share plus buffer so cross-query dedupe and the
  // interleave still fill the total cap.
  const perQueryCount = Math.min(
    options.resultCount,
    Math.max(3, Math.ceil(options.resultCount / capped.length) + 2),
  );

  const settled = await Promise.allSettled(
    capped.map((query) =>
      googleNewsEntries(query, { ...options, resultCount: perQueryCount }),
    ),
  );

  const lists: NewsEntry[][] = [];
  const failures: string[] = [];
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      if (result.value.length > 0) lists.push(result.value);
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      failures.push(`"${capped[idx]}": ${reason}`);
      console.warn(
        `[newsSearch] Fan-out query failed (continuing with others): ${reason}`,
      );
    }
  });

  if (lists.length === 0 && failures.length === capped.length) {
    throw new Error(`All fan-out queries failed — ${failures.join('; ')}`);
  }

  const entries = mergeNewsEntries(lists, options.resultCount);
  const label = capped.map((q) => `"${q}"`).join('; ');
  return {
    ...buildNewsResult(entries, label),
    providersUsed: lists.length > 0 ? ['google-news'] : [],
  };
}
