/**
 * Release notes for the "what changed?" panel behind the update banner.
 *
 * Proxies the project's public GitHub releases through a process-wide cache
 * (see releaseNotes.ts — the cache is what keeps a single-egress-IP deployment
 * under GitHub's 60/hour unauthenticated limit).
 *
 * Session-gated for consistency with the rest of the API, not for secrecy:
 * the repository is public and the notes are already world-readable.
 *
 * GET /api/releases
 */
import { NextRequest } from 'next/server';

import { getReleaseNotes } from '@/lib/services/releases/releaseNotes';

import {
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/** Client-side breather on top of the server cache. */
const CLIENT_CACHE_SECONDS = 300;

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  // Never throws: failures come back as `stale`/`unavailable` flags on a 200
  // so the panel degrades to a plain GitHub link instead of erroring.
  const payload = await getReleaseNotes();

  const response = successResponse(payload);
  response.headers.set(
    'Cache-Control',
    `private, max-age=${CLIENT_CACHE_SECONDS}`,
  );
  return response;
}
