/**
 * SearXNG metasearch provider (WEB_SEARCH_PROVIDER=searxng).
 *
 * MSF's own SearXNG instance: general web + news + science + IT +
 * humanitarian engines behind one JSON API. Upstream engines see the
 * instance's egress IP, never the app or the user — only the query leaves.
 *
 * The instance sits behind private endpoints; a Caddy proxy in front of it
 * additionally requires the shared secret in `X-Search-Key` and serves
 * `/search` only. Terraform rotates the key on both sides in one apply, so a
 * `401` can occur for the seconds between revisions — retried once.
 *
 * Deliberately NOT routed through fetchPublicUrl: the SSRF guard rejects
 * private addresses, and this endpoint is operator-configured, not
 * user-supplied.
 */
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { SearchHeadlineEntry, WebSearchCategory } from '@/types/webSearch';

import { mergeNewsEntries } from './newsSearch';

import { env } from '@/config/environment';

export interface SearxngSearchOptions {
  resultCount: number;
  freshness: 'day' | 'week' | 'month' | 'any';
  /** Router's read of the topic; defaults to 'general'. */
  category?: WebSearchCategory;
  /** Research-style question: add a second category leg for breadth. */
  deep?: boolean;
}

export interface SearxngSearchOutcome {
  entries: SearchHeadlineEntry[];
  /** Instant answers (e.g. currency conversion) — uncited lead text. */
  answers: string[];
}

/** Marks a 401 from the proxy so the caller can retry exactly once. */
export class SearxngAuthError extends Error {
  constructor() {
    super('SearXNG rejected the search key (401)');
    this.name = 'SearxngAuthError';
  }
}

// The instance caps a query at 8s (outgoing.max_request_timeout); the
// margin covers the proxy hop and response transfer.
const REQUEST_BUDGET_MS = 10_000;
// Key rotation: the gap between the proxy's and the app's new revisions.
const AUTH_RETRY_DELAY_MS = 1_500;
// Science abstracts arrive whole; keep enough to answer from, not all of it.
const SNIPPET_CHARS = 700;
const MAX_ANSWERS = 2;
const MAX_QUERIES = 5;
// Queries × primary category, plus the primary query's breadth categories.
const MAX_LEGS = 6;
const TITLE_CHARS = 200;
// Well under proxy/server request-line limits even with five legs' params.
const QUERY_CHARS = 300;

/**
 * Circuit breaker: when EVERY leg of a search fails (instance down, proxy
 * rejecting the key beyond the rotation retry, no route from this host),
 * the next searches would each burn the full request budget before falling
 * back. Skip the instance for a short cooldown instead — searches go
 * straight to the fallback, and the instance is re-probed afterwards.
 */
const FAILURE_COOLDOWN_MS = 60_000;
let unavailableUntil = 0;

/** Test-only: clears the circuit-breaker state. */
export function __resetSearxngBreakerForTests(): void {
  unavailableUntil = 0;
}

export function isSearxngConfigured(): boolean {
  return Boolean(env.SEARXNG_URL && env.SEARXNG_API_KEY);
}

/**
 * Categories whose engines support SearXNG's `time_range`. An engine
 * WITHOUT time-range support is skipped outright when the parameter is
 * present, so sending it to the science/it/humanitarian engines would
 * silently empty those searches.
 */
const TIME_RANGE_CATEGORIES: ReadonlySet<WebSearchCategory> = new Set([
  'general',
  'news',
]);

/**
 * Category legs for one question, in interleave-priority order. Each leg is
 * its own request so every category gets fair representation in the capped
 * merge — a single `categories=a,b` request ranks by engine score and lets
 * one category crowd out the other.
 */
export function planSearxngCategories(
  options: Pick<SearxngSearchOptions, 'category' | 'deep' | 'freshness'>,
): WebSearchCategory[] {
  const category = options.category ?? 'general';
  const recent = options.freshness === 'day' || options.freshness === 'week';
  switch (category) {
    case 'news':
      return options.deep ? ['news', 'general'] : ['news'];
    case 'science':
      return options.deep ? ['science', 'general'] : ['science'];
    case 'it':
      return options.deep ? ['it', 'general'] : ['it'];
    case 'humanitarian':
      // The humanitarian category is datasets only (HDX) — situation
      // coverage comes from the news engines.
      return options.deep
        ? ['humanitarian', 'news', 'general']
        : ['humanitarian', 'news'];
    default:
      // Recency-driven lookups lead with the news engines.
      if (recent) return ['news', 'general'];
      return options.deep ? ['general', 'news'] : ['general'];
  }
}

/** Builds the JSON API URL for one category leg. */
export function buildSearxngUrl(
  baseUrl: string,
  query: string,
  category: WebSearchCategory,
  freshness: SearxngSearchOptions['freshness'],
): string {
  // Relative to the configured base so a path-prefixed deployment
  // (https://host/searxng/) keeps its prefix.
  const url = new URL(
    'search',
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
  );
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', category);
  // The instance detects the language from the query text.
  url.searchParams.set('language', 'auto');
  if (freshness !== 'any' && TIME_RANGE_CATEGORIES.has(category)) {
    url.searchParams.set('time_range', freshness);
  }
  return url.toString();
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toIsoDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const time = Date.parse(value);
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

/**
 * Result text is UNTRUSTED web content headed into a numbered digest the
 * enricher later renumbers by regex. Collapsing whitespace keeps a title or
 * snippet on one line (it cannot forge a "[3] Fake source" digest entry);
 * bracketed numbers — Wikipedia footnotes, injected markers — are removed
 * so they are never mistaken for, or remapped as, our citation markers;
 * stream-marker delimiters are defused.
 */
function clip(text: string, max: number): string {
  const collapsed = text
    .replace(/\[\s*\d+\s*\]/g, '')
    .replace(/<{3,}|>{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > max
    ? `${collapsed.slice(0, max - 1).trimEnd()}…`
    : collapsed;
}

function toEntry(raw: Record<string, unknown>): SearchHeadlineEntry | null {
  const url = typeof raw.url === 'string' ? raw.url : '';
  const title =
    typeof raw.title === 'string' ? clip(raw.title, TITLE_CHARS) : '';
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const domain = hostnameOf(url);
  const snippet =
    typeof raw.content === 'string' ? clip(raw.content, SNIPPET_CHARS) : '';
  return {
    title,
    url,
    date: toIsoDate(raw.publishedDate),
    ...(domain ? { sourceName: domain, sourceUrl: `https://${domain}` } : {}),
    ...(snippet && snippet !== title ? { snippet } : {}),
  };
}

/** Infoboxes (Wikipedia/Wikidata) become a leading, citable entry. */
function infoboxEntry(
  raw: Record<string, unknown>,
): SearchHeadlineEntry | null {
  const urls = Array.isArray(raw.urls) ? raw.urls : [];
  const firstUrl = urls.find(
    (u): u is { url: string } =>
      typeof u === 'object' &&
      u !== null &&
      typeof (u as { url?: unknown }).url === 'string',
  )?.url;
  return toEntry({
    title: raw.infobox,
    url: typeof raw.id === 'string' ? raw.id : firstUrl,
    content: raw.content,
  });
}

/** Answers are plain strings on older instances, objects on newer ones. */
function answerText(raw: unknown): string {
  if (typeof raw === 'string') return clip(raw, 300);
  if (typeof raw === 'object' && raw !== null) {
    const answer = (raw as { answer?: unknown }).answer;
    if (typeof answer === 'string') return clip(answer, 300);
  }
  return '';
}

const HUB_SEGMENTS: ReadonlySet<string> = new Set([
  'tag',
  'tags',
  'topic',
  'topics',
  'category',
  'categories',
  'section',
  'sections',
  'latest',
  'live',
  'search',
  'author',
  'authors',
]);

const ARTICLE_SEGMENTS: ReadonlySet<string> = new Set([
  'article',
  'articles',
  'story',
  'stories',
  'post',
  'posts',
  'video',
  'videos',
  'press-release',
  'press-releases',
]);

/**
 * True for a publication's front door rather than a story: a homepage, a
 * section front (`/news/world/asia/india`, `/india-news`), a tag or topic
 * listing, an index page. Their snippets describe the OUTLET ("latest news,
 * breaking headlines…"), so a current-events answer built on them reports
 * on news sites instead of events. An article URL is recognised by what hub
 * URLs lack: a multi-word slug or a long numeric id in its last segment.
 */
export function isLikelyHubPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const segments = parsed.pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment).trim().toLowerCase();
      } catch {
        return segment.trim().toLowerCase();
      }
    })
    .filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((segment) => HUB_SEGMENTS.has(segment))) return true;
  const last = segments[segments.length - 1].replace(/\.[a-z0-9]{2,5}$/, '');
  if (/^(index|home|default)[a-z]?$/.test(last)) return true;

  // Story markers, any one suffices:
  //  - an article container segment before the leaf (bbc.com/news/articles/<id>)
  //  - a dated path (/2026/09/17/…, /2026/sep/17/…)
  //  - a multi-word slug (Unicode-aware: non-Latin slugs hyphenate too)
  //  - a long numeric id, in the path or the query (?PRID=2034567)
  //  - an opaque interleaved letter+digit id (cx2k4d9e1lvo)
  const inArticleContainer = segments
    .slice(0, -1)
    .some((segment) => ARTICLE_SEGMENTS.has(segment));
  const hasDatedPath = /\/(19|20)\d{2}\/(\d{1,2}|[a-z]{3})\/\d{1,2}(\/|$)/.test(
    parsed.pathname.toLowerCase(),
  );
  const hasArticleSlug = last.split(/[-_\s]+/).filter(Boolean).length >= 3;
  const hasNumericId =
    segments.some((segment) => /\d{5,}/.test(segment)) ||
    /=\d{5,}(&|$)/.test(parsed.search);
  // Opaque ids interleave letters and digits; "elections2026" (a word plus
  // a year) does not.
  const transitions = (last.match(/[a-z]\d|\d[a-z]/g) ?? []).length;
  const hasOpaqueId =
    last.length >= 8 && transitions >= 3 && !/[-_]/.test(last);
  return !(
    inArticleContainer ||
    hasDatedPath ||
    hasArticleSlug ||
    hasNumericId ||
    hasOpaqueId
  );
}

// Below this many real stories, hub pages stay (demoted) rather than
// leaving the model with almost nothing.
const MIN_ARTICLES_TO_DROP_HUBS = 3;

/**
 * Current-events searches want stories, not front pages: articles lead, and
 * hub pages are dropped once enough stories exist.
 */
export function preferArticles(
  entries: SearchHeadlineEntry[],
): SearchHeadlineEntry[] {
  const articles = entries.filter((entry) => !isLikelyHubPage(entry.url));
  if (articles.length >= MIN_ARTICLES_TO_DROP_HUBS) return articles;
  return [
    ...articles,
    ...entries.filter((entry) => isLikelyHubPage(entry.url)),
  ];
}

/** News-intent search: the news category, or a day/week recency window. */
function isCurrentEventsSearch(
  options: Pick<SearxngSearchOptions, 'category' | 'freshness'>,
): boolean {
  return (
    options.category === 'news' ||
    ((options.category ?? 'general') === 'general' &&
      (options.freshness === 'day' || options.freshness === 'week'))
  );
}

export function parseSearxngResponse(
  body: unknown,
  resultCount: number,
): SearxngSearchOutcome {
  const parsed = (body ?? {}) as {
    results?: unknown;
    infoboxes?: unknown;
    answers?: unknown;
  };
  const entries: SearchHeadlineEntry[] = [];
  const seenUrls = new Set<string>();
  const push = (entry: SearchHeadlineEntry | null) => {
    if (!entry || seenUrls.has(entry.url) || entries.length >= resultCount) {
      return;
    }
    seenUrls.add(entry.url);
    entries.push(entry);
  };

  if (Array.isArray(parsed.infoboxes) && parsed.infoboxes[0]) {
    push(infoboxEntry(parsed.infoboxes[0] as Record<string, unknown>));
  }
  // Results arrive ranked by the instance's weighted engine score.
  for (const raw of Array.isArray(parsed.results) ? parsed.results : []) {
    if (typeof raw === 'object' && raw !== null) {
      push(toEntry(raw as Record<string, unknown>));
    }
  }

  const answers = (Array.isArray(parsed.answers) ? parsed.answers : [])
    .map(answerText)
    .filter(Boolean)
    .slice(0, MAX_ANSWERS);

  return { entries, answers };
}

async function requestOnce(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_BUDGET_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'X-Search-Key': env.SEARXNG_API_KEY ?? '',
        Accept: 'application/json',
      },
      // fetch forwards custom headers across redirects — a redirect (proxy
      // misconfiguration, an external-bang query) must never carry the
      // shared secret to another host. The JSON API never redirects.
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401) {
      throw new SearxngAuthError();
    }
    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }
    const bodyText = await response.text();
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error('SearXNG returned a non-JSON response');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`SearXNG timed out after ${REQUEST_BUDGET_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One category leg: a single request, retried once on a rotation-gap 401. */
async function searchLeg(
  query: string,
  category: WebSearchCategory,
  options: Pick<SearxngSearchOptions, 'resultCount' | 'freshness'>,
): Promise<SearxngSearchOutcome & { unresponsive: string[] }> {
  const url = buildSearxngUrl(
    env.SEARXNG_URL ?? '',
    query,
    category,
    options.freshness,
  );
  let body: unknown;
  try {
    body = await requestOnce(url);
  } catch (error) {
    if (!(error instanceof SearxngAuthError)) throw error;
    console.warn(
      '[searxngSearch] 401 from the search proxy — retrying once (key rotation window)',
    );
    await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS));
    body = await requestOnce(url);
  }

  return {
    ...parseSearxngResponse(body, options.resultCount),
    unresponsive: unresponsiveEngines(body),
  };
}

/** `unresponsive_engines` is a list of [engine, reason] pairs. */
function unresponsiveEngines(body: unknown): string[] {
  const raw = (body as { unresponsive_engines?: unknown } | null)
    ?.unresponsive_engines;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      Array.isArray(item) ? item.slice(0, 2).join(': ') : String(item),
    )
    .slice(0, 20);
}

interface Leg {
  query: string;
  category: WebSearchCategory;
}

async function runLegs(
  legs: Leg[],
  options: Pick<SearxngSearchOptions, 'resultCount' | 'freshness'> & {
    articlesOnly: boolean;
  },
): Promise<SearxngSearchOutcome> {
  // Per-leg share plus buffer so cross-leg dedupe still fills the cap.
  // Article-only searches over-fetch: hub pages are filtered out AFTER the
  // merge, and the cap must still fill with stories.
  const perLegCount =
    legs.length <= 1 || options.articlesOnly
      ? options.resultCount * (options.articlesOnly ? 2 : 1)
      : Math.min(
          options.resultCount,
          Math.max(3, Math.ceil(options.resultCount / legs.length) + 2),
        );
  const settled = await Promise.allSettled(
    legs.map((leg) =>
      searchLeg(leg.query, leg.category, {
        resultCount: perLegCount,
        freshness: options.freshness,
      }),
    ),
  );

  const lists: SearchHeadlineEntry[][] = [];
  const answers: string[] = [];
  const failures: string[] = [];
  const unresponsive = new Set<string>();
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      if (result.value.entries.length > 0) lists.push(result.value.entries);
      result.value.unresponsive.forEach((engine) => unresponsive.add(engine));
      for (const answer of result.value.answers) {
        if (!answers.includes(answer)) answers.push(answer);
      }
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      failures.push(`${legs[idx].category}: ${reason}`);
      console.warn(
        `[searxngSearch] Leg ${legs[idx].category} failed (continuing with others): ${sanitizeForLog(reason)}`,
      );
    }
  });

  // One line per search, not per leg — the signal that upstream engines
  // are throttling or CAPTCHA-ing the instance's egress IP.
  if (unresponsive.size > 0) {
    console.warn(
      `[searxngSearch] Unresponsive engines: ${sanitizeForLog([...unresponsive].join(', ')).slice(0, 400)}`,
    );
  }

  if (failures.length === legs.length) {
    unavailableUntil = Date.now() + FAILURE_COOLDOWN_MS;
    throw new Error(`SearXNG search failed — ${failures.join('; ')}`);
  }
  // Round-robin interleave across legs, deduplicated by URL and title.
  const entries = options.articlesOnly
    ? preferArticles(mergeNewsEntries(lists, perLegCount * legs.length)).slice(
        0,
        options.resultCount,
      )
    : mergeNewsEntries(lists, options.resultCount);
  return { entries, answers: answers.slice(0, MAX_ANSWERS) };
}

/**
 * Runs the search. Each query (router fan-out, max 5) is one leg on the
 * primary category; the primary query also covers the plan's breadth
 * categories. At most 6 concurrent requests — the instance is ours, so the
 * bound protects the UPSTREAM engines (each leg fans out to ~5 of them, and
 * they CAPTCHA cloud egress IPs that get noisy), not SearXNG itself.
 *
 * Current-events searches (news category, or a day/week window) keep
 * stories and shed publication front pages — see isLikelyHubPage.
 *
 * A recency window that comes back EMPTY is retried once without it — a
 * sparse "past day" must not read as "nothing exists". Throws only when
 * every leg failed; an empty result returns empty entries.
 */
export async function searchSearxng(
  queries: string[],
  options: SearxngSearchOptions,
): Promise<SearxngSearchOutcome> {
  if (!isSearxngConfigured()) {
    throw new Error('SearXNG is not configured (SEARXNG_URL/SEARXNG_API_KEY)');
  }
  if (Date.now() < unavailableUntil) {
    throw new Error('SearXNG in failure cooldown (skipping)');
  }
  const capped = normalizeQueries(queries);
  if (capped.length === 0) return { entries: [], answers: [] };

  const categories = planSearxngCategories(options);
  // Every query runs on the primary category; the breadth categories
  // (deep / recency / humanitarian pairing) ride on the primary query only,
  // so a 5-query fan-out costs 6 requests, not 10-15.
  const legs: Leg[] = [
    ...capped.map((query) => ({ query, category: categories[0] })),
    ...categories.slice(1).map((category) => ({ query: capped[0], category })),
  ].slice(0, MAX_LEGS);

  const articlesOnly = isCurrentEventsSearch(options);
  console.log(
    `[searxngSearch] Plan: ${sanitizeForLog(legs.map((leg) => `${leg.category}:"${leg.query}"`).join(', '))} (freshness: ${options.freshness}, articlesOnly: ${articlesOnly})`,
  );

  const outcome = await runLegs(legs, { ...options, articlesOnly });
  const windowed =
    options.freshness !== 'any' &&
    legs.some((leg) => TIME_RANGE_CATEGORIES.has(leg.category));
  if (outcome.entries.length === 0 && windowed) {
    console.log(
      `[searxngSearch] Nothing within the "${options.freshness}" window — retrying without it`,
    );
    return runLegs(legs, { ...options, freshness: 'any', articlesOnly });
  }
  // A specialised category (science/it/humanitarian) has few engines; when
  // they find nothing, the general web usually still can.
  if (outcome.entries.length === 0 && !categories.includes('general')) {
    console.log(
      `[searxngSearch] Nothing in "${categories[0]}" — retrying on the general web`,
    );
    return runLegs(
      capped.map((query) => ({ query, category: 'general' as const })),
      { ...options, articlesOnly: false },
    );
  }
  return outcome;
}

/**
 * Queries come from the router model — or, when planning failed, straight
 * from the user's message. Bounded, de-duplicated, and stripped of SearXNG's
 * query operators: a leading `!`/`!!` (engine and EXTERNAL bangs — the
 * latter answer with a redirect), `:` (language) or `<` (timeout) on a token
 * would let message text steer the instance instead of being searched for.
 */
export function normalizeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of queries) {
    const query = raw
      .split(/\s+/)
      .map((token) => token.replace(/^[!:<?]+/, ''))
      .filter(Boolean)
      .join(' ')
      .slice(0, QUERY_CHARS)
      .trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    normalized.push(query);
    if (normalized.length >= MAX_QUERIES) break;
  }
  return normalized;
}
