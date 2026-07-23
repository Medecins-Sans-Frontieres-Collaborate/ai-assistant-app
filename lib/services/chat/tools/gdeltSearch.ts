/**
 * GDELT DOC 2.0 news search provider.
 *
 * Free, keyless, and returns REAL publisher URLs — no redirect decoding,
 * no rate-limited resolution step. News-focused (like the Google News
 * provider it runs alongside); index updates every ~15 minutes.
 */

export interface GdeltArticle {
  title: string;
  url: string;
  /** ISO timestamp derived from GDELT's `seendate` (YYYYMMDDThhmmssZ). */
  date: string;
  /** Publisher domain, e.g. `thehindu.com`. */
  domain: string;
}

export interface GdeltSearchOptions {
  resultCount: number;
  freshness: 'day' | 'week' | 'month' | 'any';
}

const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const FEED_BUDGET_MS = 10_000;

/**
 * GDELT enforces one request per 5 seconds per IP (violations get the
 * plain-text throttle message instead of results). This in-process spacer
 * prevents the app from self-inflicting that: a search starting within 5s
 * of the previous GDELT call waits out the remainder first. Worst case
 * adds <5s — and only when searches arrive back-to-back; the parallel
 * Google News leg keeps streaming regardless.
 */
const GDELT_MIN_SPACING_MS = 5_500;
let lastRequestStartedAt = 0;

/**
 * Circuit breaker: once GDELT rate-limits us it tends to keep doing so for
 * a while (and its 429 responses themselves take ~10s to arrive). Fail
 * fast during the cooldown so deep searches fall through to Google News
 * immediately instead of burning their GDELT budget on a predictable 429.
 */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
let rateLimitedUntil = 0;

function tripRateLimitBreaker(): Error {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  return new Error('GDELT rate limited this IP (1 request / 5s)');
}

/** Test-only: clears the request-spacing and circuit-breaker state. */
export function __resetGdeltRateLimitForTests(): void {
  lastRequestStartedAt = 0;
  rateLimitedUntil = 0;
}

async function waitForRateLimitWindow(): Promise<void> {
  const wait = lastRequestStartedAt + GDELT_MIN_SPACING_MS - Date.now();
  lastRequestStartedAt = Math.max(
    Date.now(),
    lastRequestStartedAt + GDELT_MIN_SPACING_MS,
  );
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

const TIMESPAN: Record<string, string> = {
  day: '24h',
  week: '1w',
  month: '1m',
  // GDELT requires a timespan window; 3 months is its practical default.
  any: '3m',
};

/** Converts GDELT's `20260721T080000Z` into a parseable ISO string. */
export function gdeltDateToIso(seendate: string): string {
  const match = seendate?.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (!match) return '';
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/** Builds the DOC 2.0 ArtList query URL. */
export function buildGdeltQueryUrl(
  query: string,
  options: GdeltSearchOptions,
): string {
  const params = new URLSearchParams({
    // Multi-word queries need quoting or GDELT treats short queries as
    // invalid; quoted-phrase + OR-less works well for router-style queries.
    query: `"${query.replace(/"/g, '')}" sourcelang:eng`,
    mode: 'ArtList',
    format: 'json',
    maxrecords: String(Math.min(options.resultCount * 2, 50)),
    sort: 'HybridRel',
    timespan: TIMESPAN[options.freshness] ?? TIMESPAN.any,
  });
  return `${GDELT_DOC_API}?${params.toString()}`;
}

export async function searchGdelt(
  query: string,
  options: GdeltSearchOptions,
): Promise<GdeltArticle[]> {
  if (Date.now() < rateLimitedUntil) {
    throw new Error('GDELT in rate-limit cooldown (skipping)');
  }
  await waitForRateLimitWindow();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_BUDGET_MS);
  try {
    const response = await fetch(buildGdeltQueryUrl(query, options), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw tripRateLimitBreaker();
    }
    if (!response.ok) {
      throw new Error(`GDELT returned ${response.status}`);
    }
    // GDELT reports query errors AND rate limiting as plain text with a
    // 200 — JSON.parse is the real success check.
    const bodyText = await response.text();
    if (bodyText.startsWith('Please limit requests')) {
      throw tripRateLimitBreaker();
    }
    let parsed: { articles?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`GDELT returned non-JSON: ${bodyText.slice(0, 120)}`);
    }

    const articles: GdeltArticle[] = [];
    const seenUrls = new Set<string>();
    for (const raw of parsed.articles ?? []) {
      const url = typeof raw.url === 'string' ? raw.url : '';
      const title = typeof raw.title === 'string' ? raw.title.trim() : '';
      if (!url || !title || seenUrls.has(url)) continue;
      seenUrls.add(url);
      articles.push({
        title,
        url,
        date: gdeltDateToIso(
          typeof raw.seendate === 'string' ? raw.seendate : '',
        ),
        domain: typeof raw.domain === 'string' ? raw.domain : '',
      });
      if (articles.length >= options.resultCount) break;
    }
    return articles;
  } finally {
    clearTimeout(timer);
  }
}
