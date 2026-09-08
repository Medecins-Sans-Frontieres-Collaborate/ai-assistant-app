/**
 * Client for `GET /api/releases`.
 *
 * Collapses every failure mode into an `unavailable` payload rather than
 * throwing. There is nothing a user can do differently about a 401, a 500 and
 * a dropped connection here — all three mean "show the GitHub link" — so the
 * panel gets one degraded path instead of three. Aborts still propagate so a
 * closing modal can tell cancellation from failure.
 */
import { githubReleasesUrl } from '@/lib/utils/shared/githubReleases';

import type { ReleaseNotesPayload } from '@/types/releases';

function unavailable(): ReleaseNotesPayload {
  return { releases: [], releasesUrl: githubReleasesUrl(), unavailable: true };
}

export async function fetchReleaseNotes(
  options: { signal?: AbortSignal } = {},
): Promise<ReleaseNotesPayload> {
  let response: Response;
  try {
    response = await fetch('/api/releases', { signal: options.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error; // caller cancelled — not a failure
    }
    return unavailable();
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success || !body.data) {
    return unavailable();
  }

  const data = body.data as ReleaseNotesPayload;
  return {
    ...data,
    releases: Array.isArray(data.releases) ? data.releases : [],
    releasesUrl: data.releasesUrl || githubReleasesUrl(),
  };
}
