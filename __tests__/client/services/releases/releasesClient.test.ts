/**
 * Release notes client.
 *
 * The contract: every failure collapses to the same `unavailable` payload
 * carrying a usable GitHub link, because there is nothing a user could do
 * differently about a 401, a 500 or a dropped connection here. Aborts are the
 * one thing that must stay distinguishable, so a closing modal can tell
 * cancellation from failure.
 */
import { fetchReleaseNotes } from '@/client/services/releases/releasesClient';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RELEASES_URL =
  'https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app/releases';

const fetchMock = vi.fn();

const RELEASE = {
  tag: 'v2026.08.31',
  name: 'v2026.08.31',
  publishedAt: '2026-08-31T20:00:25Z',
  url: `${RELEASES_URL}/tag/v2026.08.31`,
  body: "## What's Changed\n* Something",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchReleaseNotes', () => {
  it('returns the payload from a successful response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { releases: [RELEASE], releasesUrl: RELEASES_URL },
      }),
    );

    const payload = await fetchReleaseNotes();

    expect(fetchMock).toHaveBeenCalledWith('/api/releases', {
      signal: undefined,
    });
    expect(payload.releases).toEqual([RELEASE]);
    expect(payload.unavailable).toBeUndefined();
  });

  it('forwards an abort signal', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { releases: [], releasesUrl: RELEASES_URL },
      }),
    );

    await fetchReleaseNotes({ signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('rethrows an abort so a closing modal can ignore it', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    await expect(fetchReleaseNotes()).rejects.toThrow(DOMException);
  });

  it('degrades to a link when the network call fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const payload = await fetchReleaseNotes();

    expect(payload.unavailable).toBe(true);
    expect(payload.releases).toEqual([]);
    expect(payload.releasesUrl).toBe(RELEASES_URL);
  });

  it('degrades to a link on a non-OK status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Unauthorized' }, false, 401),
    );

    expect((await fetchReleaseNotes()).unavailable).toBe(true);
  });

  it('degrades to a link on an unparseable body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    expect((await fetchReleaseNotes()).unavailable).toBe(true);
  });

  it('degrades to a link when the envelope reports failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false }));

    expect((await fetchReleaseNotes()).unavailable).toBe(true);
  });

  it('repairs a payload missing its releases array', async () => {
    // Defensive: the UI maps over `releases` unconditionally.
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { releasesUrl: RELEASES_URL } }),
    );

    const payload = await fetchReleaseNotes();

    expect(payload.releases).toEqual([]);
  });

  it('supplies a fallback link when the server omitted one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { releases: [], releasesUrl: '' } }),
    );

    expect((await fetchReleaseNotes()).releasesUrl).toBe(RELEASES_URL);
  });

  it('preserves the stale flag', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { releases: [RELEASE], releasesUrl: RELEASES_URL, stale: true },
      }),
    );

    expect((await fetchReleaseNotes()).stale).toBe(true);
  });
});
