/**
 * GET /api/releases.
 *
 * The route is deliberately thin — cache and failure semantics live in the
 * service and are covered there. What is pinned here is the boundary: it is
 * session-gated, it never converts a service-level failure into an error
 * status (the panel hangs off the update banner and must degrade to a link,
 * not to a broken banner), and it carries a client cache header.
 */
import { NextRequest } from 'next/server';

import type { ReleaseNotesPayload } from '@/types/releases';

import { GET } from '@/app/api/releases/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => vi.fn());
const getReleaseNotesMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/services/releases/releaseNotes', () => ({
  getReleaseNotes: getReleaseNotesMock,
}));

const RELEASES_URL =
  'https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app/releases';

function request() {
  return new NextRequest('http://localhost:3000/api/releases');
}

async function json(response: Response) {
  return (await response.json()) as {
    success?: boolean;
    error?: string;
    data?: ReleaseNotesPayload;
  };
}

beforeEach(() => {
  authMock.mockReset();
  getReleaseNotesMock.mockReset();
  authMock.mockResolvedValue({ user: { id: 'user-1' } });
  getReleaseNotesMock.mockResolvedValue({
    releases: [
      {
        tag: 'v2026.08.31',
        name: 'v2026.08.31',
        publishedAt: '2026-08-31T20:00:25Z',
        url: `${RELEASES_URL}/tag/v2026.08.31`,
        body: "## What's Changed\n* Something",
      },
    ],
    releasesUrl: RELEASES_URL,
  } satisfies ReleaseNotesPayload);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/releases', () => {
  it('returns the cached release notes for a signed-in user', async () => {
    const response = await GET(request());
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.releases).toHaveLength(1);
    expect(body.data?.releasesUrl).toBe(RELEASES_URL);
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(getReleaseNotesMock).not.toHaveBeenCalled();
  });

  it('rejects a session with no user', async () => {
    authMock.mockResolvedValue({});

    expect((await GET(request())).status).toBe(401);
  });

  it('sets a private client cache window on top of the server cache', async () => {
    const response = await GET(request());

    const header = response.headers.get('Cache-Control');
    expect(header).toContain('private');
    expect(header).toMatch(/max-age=\d+/);
  });

  it('passes an unavailable payload through as a 200, not an error', async () => {
    // The panel must degrade to a GitHub link; an error status would make the
    // client treat a routine GitHub outage as a broken app.
    getReleaseNotesMock.mockResolvedValue({
      releases: [],
      releasesUrl: RELEASES_URL,
      unavailable: true,
    } satisfies ReleaseNotesPayload);

    const response = await GET(request());
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.unavailable).toBe(true);
    expect(body.data?.releasesUrl).toBe(RELEASES_URL);
  });

  it('passes the stale flag through', async () => {
    getReleaseNotesMock.mockResolvedValue({
      releases: [],
      releasesUrl: RELEASES_URL,
      stale: true,
    } satisfies ReleaseNotesPayload);

    expect((await json(await GET(request()))).data?.stale).toBe(true);
  });
});
