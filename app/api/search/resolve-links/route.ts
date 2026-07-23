import { NextRequest, NextResponse } from 'next/server';

import { resolveLinksSerially } from '@/lib/services/chat/tools/googleNewsSearch';

import { auth } from '@/auth';

/**
 * POST /api/search/resolve-links
 *
 * Deferred Google News link resolution. The search response streams
 * IMMEDIATELY with redirect links; the client calls this after the message
 * renders and patches the citation links in place. Resolution must happen
 * server-side — news.google.com sends no CORS headers, so the browser
 * cannot read the article page or call batchexecute itself — but running
 * it here keeps it entirely off the answer's critical path.
 *
 * Strictly scoped to news.google.com article links (this is NOT a general
 * URL-fetch proxy; anything else is rejected) and capped per request.
 */

const MAX_LINKS_PER_REQUEST = 15;

const GOOGLE_NEWS_ARTICLE_RE =
  /^https:\/\/news\.google\.com\/(?:rss\/)?articles\/[A-Za-z0-9_-]+(?:\?[^\s]*)?$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const links = (body as { links?: unknown })?.links;
  if (!Array.isArray(links) || links.length === 0) {
    return NextResponse.json(
      { error: 'links must be a non-empty array' },
      { status: 400 },
    );
  }
  if (links.length > MAX_LINKS_PER_REQUEST) {
    return NextResponse.json(
      { error: `At most ${MAX_LINKS_PER_REQUEST} links per request` },
      { status: 400 },
    );
  }

  const validLinks = links.filter(
    (link): link is string =>
      typeof link === 'string' && GOOGLE_NEWS_ARTICLE_RE.test(link),
  );
  if (validLinks.length !== links.length) {
    return NextResponse.json(
      { error: 'Only news.google.com article links can be resolved' },
      { status: 400 },
    );
  }

  const resolvedList = await resolveLinksSerially(validLinks);
  const resolved: Record<string, string> = {};
  validLinks.forEach((link, idx) => {
    // Only report actual upgrades; unresolved links stay client-side as-is.
    if (resolvedList[idx] && resolvedList[idx] !== link) {
      resolved[link] = resolvedList[idx];
    }
  });

  return NextResponse.json({ resolved });
}
