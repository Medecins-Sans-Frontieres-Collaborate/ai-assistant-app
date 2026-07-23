/**
 * Cited-source follow-up reader.
 *
 * When the user asks a follow-up about search results from an earlier turn
 * ("what did the Reuters article say?", "more detail on those protests"),
 * the original headline/snippet digest is too shallow to answer from. This
 * fetches the ACTUAL cited articles from their publishers and hands the
 * model their full text — same sources, real depth, no fresh search whose
 * results might not even overlap with what the user is asking about.
 *
 * Fetches go through the SSRF-guarded public fetcher and the shared
 * Readability extraction pipeline. Unresolvable news.google.com redirect
 * links are skipped (the aggregator shell page has no article text and
 * datacenter IPs draw 429s there) unless the resolver cache can upgrade
 * them to publisher URLs first.
 */
import { extractReadableContent } from '@/lib/services/workflows/shared/articleExtraction';

import { fetchPublicUrl } from '@/lib/utils/server/net/publicUrlGuard';

import { Citation } from '@/types/rag';

import { resolveLinksSerially } from './googleNewsSearch';

export interface CitedSourceDigest {
  text: string;
  citations: Citation[];
  /** Articles whose content was actually retrieved. */
  fetchedCount: number;
  /** Citations that qualified for fetching (had a usable publisher URL). */
  attemptedCount: number;
}

const MAX_ARTICLES = 5;
const PER_ARTICLE_CHARS = 2_800;
const PER_ARTICLE_TIMEOUT_MS = 12_000;

function isGoogleNewsLink(url: string): boolean {
  try {
    return new URL(url).hostname === 'news.google.com';
  } catch {
    return false;
  }
}

async function fetchArticleText(
  url: string,
): Promise<{ text: string; title: string } | null> {
  try {
    const { response, resolvedUrl } = await fetchPublicUrl(url, {
      timeoutMs: PER_ARTICLE_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const extracted = await extractReadableContent({
      bytes,
      contentType,
      resolvedUrl,
      isHtml: !contentType.includes('text/plain'),
    });
    return { text: extracted.text, title: extracted.title };
  } catch {
    // Paywalls, bot walls, timeouts, SSRF blocks — each article is
    // best-effort; the digest reports what was actually readable.
    return null;
  }
}

/**
 * Fetches the content of previously cited articles and builds a digest the
 * model can answer follow-ups from. Citations in the digest keep the same
 * source identity the user already saw.
 */
export async function readCitedSources(
  priorCitations: Citation[],
): Promise<CitedSourceDigest> {
  // Dedupe by URL, keep only URL-bearing citations, preserve order.
  const seen = new Set<string>();
  const candidates = priorCitations.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  // Upgrade unresolved google redirect links where cheap (legacy decode or
  // a warm resolver cache); those that stay on news.google.com are dropped.
  const googleLinks = candidates
    .map((c) => c.url)
    .filter((url) => isGoogleNewsLink(url));
  const upgrades = new Map<string, string>();
  if (googleLinks.length > 0) {
    const resolved = await resolveLinksSerially(googleLinks);
    googleLinks.forEach((link, idx) => {
      if (resolved[idx] && resolved[idx] !== link) {
        upgrades.set(link, resolved[idx]);
      }
    });
  }

  const fetchable = candidates
    .map((c) => ({ citation: c, url: upgrades.get(c.url) ?? c.url }))
    .filter(({ url }) => !isGoogleNewsLink(url))
    .slice(0, MAX_ARTICLES);

  const fetched = await Promise.all(
    fetchable.map(async ({ citation, url }) => ({
      citation,
      url,
      article: await fetchArticleText(url),
    })),
  );
  const readable = fetched.filter((f) => f.article !== null);

  if (readable.length === 0) {
    return {
      text: '',
      citations: [],
      fetchedCount: 0,
      attemptedCount: fetchable.length,
    };
  }

  const citations = readable.map(({ citation, url }, idx) => ({
    ...citation,
    url,
    number: idx + 1,
  }));

  const sections = readable.map(({ citation, article }, idx) => {
    const title = citation.title || article!.title || citation.url;
    const source = citation.sourceName ? ` — ${citation.sourceName}` : '';
    const body =
      article!.text.length > PER_ARTICLE_CHARS
        ? `${article!.text.slice(0, PER_ARTICLE_CHARS)}\n[…article truncated]`
        : article!.text;
    return `[${idx + 1}] ${title}${source}\n${body}`;
  });

  const text =
    `Full article content from the sources previously cited in this conversation ` +
    `(fetched for this follow-up — answer from these and cite by number):\n\n` +
    sections.join('\n\n---\n\n');

  return {
    text,
    citations,
    fetchedCount: readable.length,
    attemptedCount: fetchable.length,
  };
}
