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
const MAX_LEGS = 5;

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
  const url = new URL('/search', baseUrl);
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

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max
    ? `${collapsed.slice(0, max - 1).trimEnd()}…`
    : collapsed;
}

function toEntry(raw: Record<string, unknown>): SearchHeadlineEntry | null {
  const url = typeof raw.url === 'string' ? raw.url : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
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
): Promise<SearxngSearchOutcome> {
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

  const unresponsive = (body as { unresponsive_engines?: unknown })
    ?.unresponsive_engines;
  if (Array.isArray(unresponsive) && unresponsive.length > 0) {
    console.warn(
      `[searxngSearch] Unresponsive engines (${category}): ${JSON.stringify(unresponsive).slice(0, 300)}`,
    );
  }
  return parseSearxngResponse(body, options.resultCount);
}

interface Leg {
  query: string;
  category: WebSearchCategory;
}

async function runLegs(
  legs: Leg[],
  options: Pick<SearxngSearchOptions, 'resultCount' | 'freshness'>,
): Promise<SearxngSearchOutcome> {
  // Per-leg share plus buffer so cross-leg dedupe still fills the cap.
  const perLegCount =
    legs.length <= 1
      ? options.resultCount
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
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      if (result.value.entries.length > 0) lists.push(result.value.entries);
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
        `[searxngSearch] Leg ${legs[idx].category} failed (continuing with others): ${reason}`,
      );
    }
  });

  if (failures.length === legs.length) {
    throw new Error(`SearXNG search failed — ${failures.join('; ')}`);
  }
  return {
    // Round-robin interleave across legs, deduplicated by URL and title.
    entries: mergeNewsEntries(lists, options.resultCount),
    answers: answers.slice(0, MAX_ANSWERS),
  };
}

/**
 * Runs the search. A single query fans out across the planned categories; a
 * multi-aspect question (router fan-out) runs one leg per query on the
 * primary category instead. At most 5 concurrent requests either way.
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
  const capped = queries.filter((q) => q.trim().length > 0).slice(0, MAX_LEGS);
  if (capped.length === 0) return { entries: [], answers: [] };

  const categories = planSearxngCategories(options);
  const legs: Leg[] =
    capped.length > 1
      ? capped.map((query) => ({ query, category: categories[0] }))
      : categories.map((category) => ({ query: capped[0], category }));

  const outcome = await runLegs(legs, options);
  const windowed =
    options.freshness !== 'any' &&
    legs.some((leg) => TIME_RANGE_CATEGORIES.has(leg.category));
  if (outcome.entries.length === 0 && windowed) {
    console.log(
      `[searxngSearch] Nothing within the "${options.freshness}" window — retrying without it`,
    );
    return runLegs(legs, { ...options, freshness: 'any' });
  }
  return outcome;
}
