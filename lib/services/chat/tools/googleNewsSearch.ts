/**
 * Google News RSS web-search provider — the Bing-grounding alternative
 * (WEB_SEARCH_PROVIDER=google-news).
 *
 * Flow: query → news.google.com RSS search feed → top-N items → resolve
 * Google's redirect links to the real article URLs → return a headline/
 * snippet digest plus citations. No LLM round-trip at all: the PICKED model
 * synthesizes from the digest, which makes this path seconds-fast where the
 * Bing agent takes 30-90s.
 *
 * Link resolution mirrors the Python `googlenewsdecoder` library:
 *  - pre-2024 links (`articles/CBMi…`) embed the target URL in base64 —
 *    decoded locally, zero network.
 *  - newer links need Google's `batchexecute` endpoint: fetch the article
 *    page for its signature/timestamp attributes, then POST to decode.
 *  - any failure falls back to the news.google.com link, which still
 *    redirects fine in a browser — resolution is best-effort polish.
 *
 * Privacy: only the (router-generated) query reaches Google — same posture
 * as the Bing path, where only the query reaches the Foundry agent.
 */

export interface GoogleNewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  /** Publisher site URL from the <source url="..."> attribute. */
  sourceUrl: string;
  snippet: string;
}

export interface GoogleNewsSearchOptions {
  resultCount: number;
  freshness: 'day' | 'week' | 'month' | 'any';
  /** Feed locale (hl/gl/ceid). Defaults to en-US/US. */
  language?: string;
  country?: string;
}

export interface GoogleNewsSearchResult {
  text: string;
  citations: Array<{
    number: number;
    title: string;
    url: string;
    date: string;
    sourceName?: string;
    sourceUrl?: string;
  }>;
}

const FEED_BUDGET_MS = 10_000;
const RESOLVE_BUDGET_MS = 4_000;
const BATCHEXECUTE_URL =
  'https://news.google.com/_/DotsSplashUi/data/batchexecute';

/** Browser-shaped headers — bare fetch UAs draw 429s much sooner. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const FRESHNESS_OPERATOR: Record<string, string> = {
  day: ' when:1d',
  week: ' when:7d',
  month: ' when:30d',
  any: '',
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagContent(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'),
  );
  return match ? decodeXmlEntities(match[1]) : '';
}

/**
 * Minimal tolerant parser for the Google News RSS search feed. The feed is
 * machine-generated and regular; a full XML parser dependency isn't
 * warranted for five well-known tags per <item>.
 */
export function parseGoogleNewsRss(xml: string): GoogleNewsItem[] {
  const items: GoogleNewsItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const block of itemBlocks) {
    const link = tagContent(block, 'link');
    if (!link) continue;
    // Google appends " - Source" to titles; the <source> tag is canonical.
    const source = tagContent(block, 'source');
    const sourceUrl = block.match(/<source[^>]*\surl="([^"]+)"/i)?.[1] ?? '';
    let title = tagContent(block, 'title');
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3));
    }
    items.push({
      title,
      link,
      pubDate: tagContent(block, 'pubDate'),
      source,
      sourceUrl: decodeXmlEntities(sourceUrl),
      snippet: stripHtml(decodeXmlEntities(tagContent(block, 'description'))),
    });
  }
  return items;
}

/**
 * Pre-2024 decoder: `articles/<id>` ids starting with CBMi/CBM are base64
 * protobuf with the target URL embedded as readable bytes. Local, instant.
 */
export function decodeLegacyGoogleNewsUrl(link: string): string | null {
  const match = link.match(/\/(?:articles|rss\/articles)\/([^/?]+)/);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('latin1');
    // The embedded URL is plain printable ASCII; the surrounding protobuf
    // framing bytes fall outside [!-~] and terminate the match naturally.
    const urlMatch = decoded.match(/https?:\/\/[!-~]+/);
    if (!urlMatch) return null;
    const url = urlMatch[0];
    if (!/^https?:\/\/[^/]+\.[a-z]{2,}/i.test(url)) return null;
    if (url.includes('news.google.com')) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchWithBudget(
  url: string,
  init: RequestInit,
  budgetMs: number,
): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * New-format decoder (2024+ links): fetch the article page for the
 * signature/timestamp data attributes, then ask Google's batchexecute
 * endpoint for the real URL — the same two-step the Python
 * `googlenewsdecoder` performs.
 */
async function decodeViaBatchExecute(link: string): Promise<string | null> {
  const idMatch = link.match(/\/(?:articles|rss\/articles)\/([^/?]+)/);
  if (!idMatch) return null;
  const articleId = idMatch[1];

  const pageResponse = await fetchWithBudget(
    `https://news.google.com/articles/${articleId}`,
    { headers: BROWSER_HEADERS },
    RESOLVE_BUDGET_MS,
  );
  if (!pageResponse.ok) return null;
  const html = await pageResponse.text();
  const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!signature || !timestamp) return null;

  const articleReq = [
    'Fbv4je',
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${articleId}",${timestamp},"${signature}"]`,
  ];
  const body = `f.req=${encodeURIComponent(JSON.stringify([[articleReq]]))}`;

  const decodeResponse = await fetchWithBudget(
    BATCHEXECUTE_URL,
    {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body,
    },
    RESOLVE_BUDGET_MS,
  );
  if (!decodeResponse.ok) return null;
  const payload = await decodeResponse.text();
  const urlMatch = payload.match(/"garturlres","(https?:\/\/[^"]+)"/);
  if (urlMatch) return urlMatch[1];
  // Some responses carry the URL as the second element of the inner array.
  const fallback = payload.match(/\["(https?:\/\/(?!news\.google)[^"]+)"/);
  return fallback ? fallback[1] : null;
}

/**
 * Resolves a Google News redirect link to the publisher URL. Best-effort
 * with a hard budget; the google link itself is the always-valid fallback.
 */
export async function resolveGoogleNewsLink(link: string): Promise<string> {
  if (!link.includes('news.google.com')) return link;
  const legacy = decodeLegacyGoogleNewsUrl(link);
  if (legacy) return legacy;
  try {
    const resolved = await decodeViaBatchExecute(link);
    if (resolved) return resolved;
  } catch {
    // Budget exceeded or Google changed the endpoint — fallback below.
  }
  return link;
}

/** Resolved-link cache: repeat/related queries skip Google entirely. */
const RESOLVE_CACHE_MAX = 500;
const resolveCache = new Map<string, string>();

const SERIAL_RESOLVE_TOTAL_BUDGET_MS = 8_000;
const SERIAL_RESOLVE_SPACING_MS = 250;

/**
 * Resolves links one at a time with spacing, under a shared budget.
 * Legacy-format links decode locally (instant, no network, no budget
 * spend); only new-format links hit Google, gently enough to stay under
 * its rate limiting. Unresolved links pass through unchanged.
 */
export async function resolveLinksSerially(links: string[]): Promise<string[]> {
  const results: string[] = [];
  const deadline = Date.now() + SERIAL_RESOLVE_TOTAL_BUDGET_MS;
  let usedNetwork = false;

  for (const link of links) {
    const cached = resolveCache.get(link);
    if (cached) {
      results.push(cached);
      continue;
    }
    // Local decode is free — always attempt it.
    const legacy = link.includes('news.google.com')
      ? decodeLegacyGoogleNewsUrl(link)
      : link;
    if (legacy) {
      resolveCache.set(link, legacy);
      results.push(legacy);
      continue;
    }
    if (Date.now() >= deadline) {
      results.push(link);
      continue;
    }
    if (usedNetwork) {
      await new Promise((r) => setTimeout(r, SERIAL_RESOLVE_SPACING_MS));
    }
    usedNetwork = true;
    const resolved = await resolveGoogleNewsLink(link).catch(() => link);
    if (resolved !== link) {
      resolveCache.set(link, resolved);
      if (resolveCache.size > RESOLVE_CACHE_MAX) {
        const oldest = resolveCache.keys().next().value;
        if (oldest) resolveCache.delete(oldest);
      }
    }
    results.push(resolved);
  }
  return results;
}

/** Builds the RSS search URL (see the referenced Stack Overflow format). */
export function buildGoogleNewsFeedUrl(
  query: string,
  options: GoogleNewsSearchOptions,
): string {
  const language = options.language ?? 'en-US';
  const country = options.country ?? 'US';
  const q = `${query}${FRESHNESS_OPERATOR[options.freshness] ?? ''}`;
  const params = new URLSearchParams({
    q,
    hl: language,
    gl: country,
    ceid: `${country}:${language.split('-')[0]}`,
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

/** Fetches and parses the search feed — the raw-items half of the search,
 * shared with the parallel news orchestrator. */
export async function fetchGoogleNewsItems(
  query: string,
  options: GoogleNewsSearchOptions,
): Promise<GoogleNewsItem[]> {
  const feedUrl = buildGoogleNewsFeedUrl(query, options);
  const response = await fetchWithBudget(
    feedUrl,
    { headers: BROWSER_HEADERS },
    FEED_BUDGET_MS,
  );
  if (!response.ok) {
    throw new Error(`Google News feed returned ${response.status}`);
  }
  return parseGoogleNewsRss(await response.text()).slice(
    0,
    options.resultCount,
  );
}

export async function searchGoogleNews(
  query: string,
  options: GoogleNewsSearchOptions,
): Promise<GoogleNewsSearchResult> {
  const items = await fetchGoogleNewsItems(query, options);
  if (items.length === 0) {
    return { text: '', citations: [] };
  }

  // Resolution is OFF the search path: only the free local legacy decode
  // runs here (instant, zero network). New-format links go out as google
  // redirect links — the CLIENT upgrades them after the message renders via
  // POST /api/search/resolve-links, so resolution never delays the answer.
  // The citation still shows the true publisher via sourceName/sourceUrl.
  const resolvedLinks = items.map(
    (item) => decodeLegacyGoogleNewsUrl(item.link) ?? item.link,
  );

  const citations = items.map((item, idx) => ({
    number: idx + 1,
    title: item.title || item.source || 'Untitled',
    url: resolvedLinks[idx],
    date: item.pubDate,
    ...(item.source ? { sourceName: item.source } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
  }));

  const digest = items
    .map((item, idx) => {
      const meta = [item.source, item.pubDate].filter(Boolean).join(', ');
      return `[${idx + 1}] ${item.title}${meta ? ` (${meta})` : ''}${
        item.snippet && item.snippet !== item.title ? `\n${item.snippet}` : ''
      }`;
    })
    .join('\n\n');

  const text =
    `Recent news results for "${query}" (headlines and snippets — synthesize an answer from these and cite by number):\n\n` +
    digest;

  return { text, citations };
}
