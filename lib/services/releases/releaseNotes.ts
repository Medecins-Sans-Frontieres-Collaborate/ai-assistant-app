/**
 * Release notes feed.
 *
 * Fetches the project's public GitHub releases and caches them process-wide so
 * the app makes roughly one upstream call per hour no matter how many people
 * open the panel. That cache is not an optimization — it is the feature's
 * load-bearing part. Unauthenticated api.github.com allows 60 requests/hour
 * PER IP and the container app egresses from a single IP, so an uncached proxy
 * would start returning 403s within minutes at real user counts.
 *
 * Everything here degrades to a link. The panel hangs off the update banner,
 * so a GitHub outage, a blocked egress, or a rate-limit must never produce
 * anything worse than "here's the releases page".
 */
import {
  DEFAULT_RELEASES_REPO,
  REPO_SLUG_PATTERN,
  githubReleasesUrl,
} from '@/lib/utils/shared/githubReleases';

import type { ReleaseNote, ReleaseNotesPayload } from '@/types/releases';

/** How long a good response is served without re-asking GitHub. */
export const RELEASES_CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * How long a failure suppresses further attempts. Without this, an expired
 * cache plus a persistent failure (blocked egress being the likely one) turns
 * every poll into an upstream call that is guaranteed to fail.
 */
export const RELEASES_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** A blocked egress hangs rather than refuses, so the timeout is the real guard. */
export const RELEASES_FETCH_TIMEOUT_MS = 5000;
/** Releases shown. Over-fetched because drafts/prereleases are dropped after. */
export const RELEASES_DISPLAY_COUNT = 5;
export const RELEASES_FETCH_COUNT = 10;
/** Defensive ceiling on one body; a release note has no business being longer. */
export const MAX_BODY_CHARS = 20_000;

/** Resolved once per call so tests can move the clock. */
let nowFn: () => number = () => Date.now();

/** Test seam. Pass null to restore the real clock. */
export function setNowFnForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/**
 * Repo to read releases from. The env override exists for forks; a malformed
 * value falls back to the default rather than being interpolated into a URL.
 */
export function getRepoSlug(): string {
  const configured = process.env.GITHUB_RELEASES_REPO?.trim();
  if (configured && REPO_SLUG_PATTERN.test(configured)) return configured;
  return DEFAULT_RELEASES_REPO;
}

export function getReleasesUrl(): string {
  return githubReleasesUrl(getRepoSlug());
}

/** Deploy footer the CI workflow prepends — meaningless to a user. */
const DEPLOY_LINE = /^Deployed to .*\[workflow run\]\(.*$/gm;
/** GitHub's "notes generated using configuration in .github/release.yml" marker. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** Trailing compare link; the per-PR links above it are the useful ones. */
const FULL_CHANGELOG_LINE = /^\*\*Full Changelog\*\*:.*$/gm;
/** Bare PR URLs, which GitHub's generated notes emit unlinked and in full. */
const PR_URL =
  /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)\b/g;

/**
 * Strips CI plumbing from a generated release body and shortens the bare PR
 * URLs to `#123` links.
 *
 * Deliberately conservative: it removes only lines this project's own workflow
 * is known to emit and never touches the "What's Changed" list itself, so a
 * hand-written release note passes through intact.
 */
export function cleanReleaseBody(raw: string): string {
  if (!raw) return '';

  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(HTML_COMMENT, '')
    .replace(DEPLOY_LINE, '')
    .replace(FULL_CHANGELOG_LINE, '')
    .replace(PR_URL, (url, number) => `[#${number}](${url})`)
    // Collapse the blank runs the removals leave behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length <= MAX_BODY_CHARS) return cleaned;
  // Cut at a line boundary so the truncation never lands mid-markdown.
  const cut = cleaned.slice(0, MAX_BODY_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return `${(lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n\n…`;
}

/** Shape of the fields we read off GitHub's release objects. */
interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * Normalizes one GitHub release, or null if it is unusable.
 *
 * The `html_url` prefix check is not paranoia about GitHub: it keeps an
 * unexpected payload from putting an arbitrary scheme into an anchor href
 * downstream.
 */
function toReleaseNote(
  raw: GitHubRelease,
  fallbackUrl: string,
): ReleaseNote | null {
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  if (!tag) return null;

  const name =
    typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : tag;
  const url =
    typeof raw.html_url === 'string' &&
    raw.html_url.startsWith('https://github.com/')
      ? raw.html_url
      : fallbackUrl;

  return {
    tag,
    name,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    url,
    body: cleanReleaseBody(typeof raw.body === 'string' ? raw.body : ''),
  };
}

async function fetchFromGitHub(): Promise<ReleaseNotesPayload> {
  const slug = getRepoSlug();
  const releasesUrl = githubReleasesUrl(slug);

  const response = await fetch(
    `https://api.github.com/repos/${slug}/releases?per_page=${RELEASES_FETCH_COUNT}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub rejects requests without one.
        'User-Agent': 'msf-ai-assistant',
      },
      signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
      // Our own cache is the one that matters; Next's would double-cache with
      // a TTL we don't control.
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub releases request failed (${response.status})`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Unexpected GitHub releases payload');
  }

  const releases = (payload as GitHubRelease[])
    .filter((entry) => entry && !entry.draft && !entry.prerelease)
    .map((entry) => toReleaseNote(entry, releasesUrl))
    .filter((entry): entry is ReleaseNote => entry !== null)
    .slice(0, RELEASES_DISPLAY_COUNT);

  return { releases, releasesUrl };
}

let cached: { payload: ReleaseNotesPayload; expiresAt: number } | null = null;
let lastFailureAt = 0;
let inFlight: Promise<ReleaseNotesPayload> | null = null;

/** Test seam — module state otherwise leaks between cases. */
export function resetReleaseNotesCacheForTests(): void {
  cached = null;
  lastFailureAt = 0;
  inFlight = null;
}

function unavailablePayload(): ReleaseNotesPayload {
  return { releases: [], releasesUrl: getReleasesUrl(), unavailable: true };
}

/**
 * Cached release notes. Never rejects: callers get either notes, a stale copy
 * flagged as such, or an empty list flagged `unavailable` — all of which the
 * UI renders as "here's the GitHub link" at worst.
 */
export async function getReleaseNotes(): Promise<ReleaseNotesPayload> {
  const now = nowFn();

  if (cached && now < cached.expiresAt) return cached.payload;

  // Inside the failure window, answer from whatever we have without asking.
  if (now - lastFailureAt < RELEASES_FAILURE_BACKOFF_MS) {
    return cached ? { ...cached.payload, stale: true } : unavailablePayload();
  }

  // Single-flight: a burst of pollers arriving on an expired cache must
  // produce one upstream call, not one per request.
  if (!inFlight) {
    inFlight = fetchFromGitHub()
      .then((payload) => {
        cached = { payload, expiresAt: nowFn() + RELEASES_CACHE_TTL_MS };
        lastFailureAt = 0;
        return payload;
      })
      .catch((error) => {
        lastFailureAt = nowFn();
        console.warn(
          '[releases] Failed to fetch release notes:',
          error instanceof Error ? error.message : error,
        );
        return cached
          ? { ...cached.payload, stale: true }
          : unavailablePayload();
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}
