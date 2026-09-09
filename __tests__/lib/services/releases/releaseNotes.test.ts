/**
 * Release notes service.
 *
 * Two contracts are pinned here. First, body cleaning removes only the CI
 * plumbing this project's own workflow emits and leaves everything else
 * alone — a hand-written note must survive untouched. Second, the caching
 * layer, which is load-bearing rather than an optimization: unauthenticated
 * api.github.com allows 60 requests/hour per IP and the app egresses from one
 * IP, so "one upstream call per hour regardless of traffic" and "a failure
 * does not turn every poll into a doomed upstream call" are correctness
 * properties, not performance ones.
 */
import {
  MAX_BODY_CHARS,
  RELEASES_CACHE_TTL_MS,
  RELEASES_FAILURE_BACKOFF_MS,
  cleanReleaseBody,
  getReleaseNotes,
  getReleasesUrl,
  getRepoSlug,
  resetReleaseNotesCacheForTests,
  setNowFnForTests,
} from '@/lib/services/releases/releaseNotes';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO = 'Medecins-Sans-Frontieres-Collaborate/ai-assistant-app';
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

let clock = NOW;
const fetchMock = vi.fn();

/** A release exactly as GitHub's generated notes produce it here. */
function ghRelease(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v2026.08.31',
    name: 'v2026.08.31',
    published_at: '2026-08-31T20:00:25Z',
    html_url: `https://github.com/${REPO}/releases/tag/v2026.08.31`,
    draft: false,
    prerelease: false,
    body: [
      `Deployed to **live** by @someone — [workflow run](https://github.com/${REPO}/actions/runs/33433553019), image tag \`latest\`.`,
      '<!-- Release notes generated using configuration in .github/release.yml at e678cd22 -->',
      '',
      "## What's Changed",
      `* Derives the viewer's public origin by @someone in https://github.com/${REPO}/pull/117`,
      '',
      '',
      `**Full Changelog**: https://github.com/${REPO}/compare/v2026.08.27...v2026.08.31`,
    ].join('\n'),
    ...overrides,
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  clock = NOW;
  setNowFnForTests(() => clock);
  resetReleaseNotesCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // The failure paths log by design; keep the test output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.GITHUB_RELEASES_REPO;
});

afterEach(() => {
  setNowFnForTests(null);
  resetReleaseNotesCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GITHUB_RELEASES_REPO;
});

describe('getRepoSlug', () => {
  it('defaults to the project repository', () => {
    expect(getRepoSlug()).toBe(REPO);
    expect(getReleasesUrl()).toBe(`https://github.com/${REPO}/releases`);
  });

  it('honours a well-formed override', () => {
    process.env.GITHUB_RELEASES_REPO = 'someone/their-fork';
    expect(getRepoSlug()).toBe('someone/their-fork');
  });

  it('ignores a malformed override rather than interpolating it into a URL', () => {
    // A traversal-shaped value must not reach the request path.
    process.env.GITHUB_RELEASES_REPO = '../../evil';
    expect(getRepoSlug()).toBe(REPO);

    process.env.GITHUB_RELEASES_REPO = 'no-slash';
    expect(getRepoSlug()).toBe(REPO);

    process.env.GITHUB_RELEASES_REPO = 'a/b?query=1';
    expect(getRepoSlug()).toBe(REPO);
  });
});

describe('cleanReleaseBody', () => {
  it('strips the deploy footer, the generation comment and the compare link', () => {
    const cleaned = cleanReleaseBody(ghRelease().body as string);

    expect(cleaned).not.toContain('Deployed to');
    expect(cleaned).not.toContain('workflow run');
    expect(cleaned).not.toContain('<!--');
    expect(cleaned).not.toContain('Full Changelog');
  });

  it("keeps the What's Changed list, which is the part worth reading", () => {
    const cleaned = cleanReleaseBody(ghRelease().body as string);

    expect(cleaned).toContain("## What's Changed");
    expect(cleaned).toContain("Derives the viewer's public origin");
    expect(cleaned).toContain('@someone');
  });

  it('shortens bare PR URLs into numbered links', () => {
    const cleaned = cleanReleaseBody(ghRelease().body as string);

    expect(cleaned).toContain(`[#117](https://github.com/${REPO}/pull/117)`);
    expect(cleaned).not.toMatch(/in https:\/\/github\.com/);
  });

  it('collapses the blank runs the removals leave behind', () => {
    expect(cleanReleaseBody(ghRelease().body as string)).not.toMatch(/\n{3,}/);
  });

  it('starts and ends on content', () => {
    const cleaned = cleanReleaseBody(ghRelease().body as string);

    expect(cleaned).toBe(cleaned.trim());
    expect(cleaned.startsWith("## What's Changed")).toBe(true);
  });

  it('keeps the rollback line, which is the whole point of a rollback release', () => {
    const body = [
      `Deployed to **live** by @someone — [workflow run](https://github.com/${REPO}/actions/runs/1), image tag \`abc1234\`.`,
      '',
      '⏪ Rollback to `abc1234` (already included in v2026.08.27).',
    ].join('\n');

    const cleaned = cleanReleaseBody(body);

    expect(cleaned).toBe(
      '⏪ Rollback to `abc1234` (already included in v2026.08.27).',
    );
  });

  it('leaves a hand-written note untouched', () => {
    const body =
      '## Highlights\n\n- Faster meeting import\n- Fixed a crash on export\n';

    expect(cleanReleaseBody(body)).toBe(
      '## Highlights\n\n- Faster meeting import\n- Fixed a crash on export',
    );
  });

  it('normalizes CRLF so the line-anchored strips still match', () => {
    const body = `Deployed to **live** by @someone — [workflow run](https://github.com/${REPO}/actions/runs/1), image tag \`latest\`.\r\n\r\n## What's Changed\r\n* A change`;

    const cleaned = cleanReleaseBody(body);

    expect(cleaned).not.toContain('Deployed to');
    expect(cleaned).not.toContain('\r');
    expect(cleaned).toContain('* A change');
  });

  it('returns an empty string for an empty body', () => {
    expect(cleanReleaseBody('')).toBe('');
  });

  it('truncates an oversized body at a line boundary', () => {
    const line = `${'x'.repeat(99)}\n`;
    const body = line.repeat(Math.ceil((MAX_BODY_CHARS * 1.5) / line.length));

    const cleaned = cleanReleaseBody(body);

    expect(cleaned.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 4);
    expect(cleaned.endsWith('\n\n…')).toBe(true);
    // Never mid-line: every retained line is a whole one.
    const lines = cleaned.slice(0, -3).trimEnd().split('\n');
    expect(lines.every((entry) => entry.length === 99)).toBe(true);
  });
});

describe('getReleaseNotes', () => {
  it('requests the configured repo with the headers GitHub requires', async () => {
    fetchMock.mockResolvedValue(okResponse([ghRelease()]));

    await getReleaseNotes();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`https://api.github.com/repos/${REPO}/releases`);
    // GitHub rejects requests without a User-Agent outright.
    expect(init.headers['User-Agent']).toBeTruthy();
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Our cache is the one that matters; Next's would double-cache.
    expect(init.cache).toBe('no-store');
  });

  it('normalizes a release into the display shape', async () => {
    fetchMock.mockResolvedValue(okResponse([ghRelease()]));

    const { releases } = await getReleaseNotes();

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      tag: 'v2026.08.31',
      name: 'v2026.08.31',
      publishedAt: '2026-08-31T20:00:25Z',
      url: `https://github.com/${REPO}/releases/tag/v2026.08.31`,
    });
    expect(releases[0].body).toContain("## What's Changed");
  });

  it('serves later calls from cache without touching GitHub', async () => {
    fetchMock.mockResolvedValue(okResponse([ghRelease()]));

    await getReleaseNotes();
    clock += RELEASES_CACHE_TTL_MS - 1;
    await getReleaseNotes();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache expires', async () => {
    fetchMock.mockResolvedValue(okResponse([ghRelease()]));

    await getReleaseNotes();
    clock += RELEASES_CACHE_TTL_MS + 1;
    await getReleaseNotes();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses a concurrent burst into one upstream call', async () => {
    // The banner polls on a timer, so a cold cache is hit by many requests at
    // once — one per request would blow the rate limit on the first minute.
    let release!: (value: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(okResponse([ghRelease()]));
        }),
    );

    const pending = [
      getReleaseNotes(),
      getReleaseNotes(),
      getReleaseNotes(),
      getReleaseNotes(),
    ];
    release(undefined);
    const results = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((entry) => entry.releases.length === 1)).toBe(true);
  });

  it('drops drafts and prereleases', async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        ghRelease({ tag_name: 'v1', draft: true }),
        ghRelease({ tag_name: 'v2', prerelease: true }),
        ghRelease({ tag_name: 'v3' }),
      ]),
    );

    const { releases } = await getReleaseNotes();

    expect(releases.map((entry) => entry.tag)).toEqual(['v3']);
  });

  it('drops entries with no tag rather than rendering a blank row', async () => {
    fetchMock.mockResolvedValue(
      okResponse([ghRelease({ tag_name: '' }), ghRelease({ tag_name: 'v9' })]),
    );

    const { releases } = await getReleaseNotes();

    expect(releases.map((entry) => entry.tag)).toEqual(['v9']);
  });

  it('caps the list at five even though it over-fetches', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        Array.from({ length: 10 }, (_, index) =>
          ghRelease({ tag_name: `v${index}` }),
        ),
      ),
    );

    const { releases } = await getReleaseNotes();

    expect(releases).toHaveLength(5);
  });

  it('falls back to the releases page for an unexpected html_url', async () => {
    // Keeps an odd payload from putting an arbitrary scheme into an href.
    fetchMock.mockResolvedValue(
      okResponse([ghRelease({ html_url: 'javascript:alert(1)' })]),
    );

    const { releases } = await getReleaseNotes();

    expect(releases[0].url).toBe(`https://github.com/${REPO}/releases`);
  });

  it('reports unavailable, with a link, when GitHub errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    });

    const payload = await getReleaseNotes();

    expect(payload.unavailable).toBe(true);
    expect(payload.releases).toEqual([]);
    // The escape hatch must survive every failure mode.
    expect(payload.releasesUrl).toBe(`https://github.com/${REPO}/releases`);
  });

  it('reports unavailable when the network call throws', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    expect((await getReleaseNotes()).unavailable).toBe(true);
  });

  it('reports unavailable when the payload is not a list', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ message: 'API rate limit exceeded' }),
    );

    expect((await getReleaseNotes()).unavailable).toBe(true);
  });

  it('serves the last good notes, flagged stale, when a refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([ghRelease()]));
    await getReleaseNotes();

    clock += RELEASES_CACHE_TTL_MS + 1;
    fetchMock.mockRejectedValueOnce(new Error('blocked'));
    const payload = await getReleaseNotes();

    expect(payload.stale).toBe(true);
    expect(payload.unavailable).toBeUndefined();
    expect(payload.releases).toHaveLength(1);
  });

  it('backs off after a failure instead of retrying on every request', async () => {
    // A blocked egress fails deterministically; without the backoff each poll
    // would spend a doomed upstream call and the request's own latency.
    fetchMock.mockRejectedValue(new Error('blocked'));

    await getReleaseNotes();
    clock += RELEASES_FAILURE_BACKOFF_MS - 1;
    await getReleaseNotes();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tries again once the backoff window passes', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blocked'));
    await getReleaseNotes();

    clock += RELEASES_FAILURE_BACKOFF_MS + 1;
    fetchMock.mockResolvedValueOnce(okResponse([ghRelease()]));
    const payload = await getReleaseNotes();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload.releases).toHaveLength(1);
    expect(payload.unavailable).toBeUndefined();
  });

  it('clears the failure window after a success', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blocked'));
    await getReleaseNotes();

    clock += RELEASES_FAILURE_BACKOFF_MS + 1;
    fetchMock.mockResolvedValueOnce(okResponse([ghRelease()]));
    await getReleaseNotes();

    // Cache expires; a fresh failure must be allowed to try, not be
    // suppressed by the stale timestamp from before the success.
    clock += RELEASES_CACHE_TTL_MS + 1;
    fetchMock.mockRejectedValueOnce(new Error('blocked again'));
    await getReleaseNotes();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
