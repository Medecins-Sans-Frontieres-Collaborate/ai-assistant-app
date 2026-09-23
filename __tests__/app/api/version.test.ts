/**
 * GET /api/version — the client message funnel
 * (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §3).
 *
 * The invariants here protect the clients that matter most: OLD tabs, which
 * read `build` and nothing else, and every tab's background poll, which must
 * never be answered with a 401 or a failure caused by announcements.
 */
import { NextRequest } from 'next/server';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const announcementsDocument = vi.hoisted(() => ({
  value: null as unknown,
  ensureFresh: vi.fn(),
}));
const delegationsEnsureFresh = vi.hoisted(() => vi.fn());
const enabledDelegations = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/announcements/AnnouncementsService', () => ({
  AnnouncementsService: {
    getInstance: () => ({
      ensureFresh: announcementsDocument.ensureFresh,
      getDocument: () => announcementsDocument.value,
    }),
  },
}));
vi.mock('@/lib/services/delegations/DelegationsService', () => ({
  DelegationsService: {
    getInstance: () => ({
      ensureFresh: delegationsEnsureFresh,
      getEnabledDelegations: () => enabledDelegations.value,
    }),
  },
}));
vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: (session: { user: { mail: string } }) => ({
    userId: 'oid',
    mail: session.user.mail,
    domain: session.user.mail.split('@')[1],
    attributes: [],
    groupIds: [],
  }),
}));

const STAMP = {
  createdBy: 'g',
  createdAt: 'x',
  updatedBy: 'g',
  updatedAt: 'x',
};

function announcement(extra: Record<string, unknown> = {}) {
  return {
    id: 'ann-000000000001',
    revision: 1,
    status: 'published',
    severity: 'info',
    dismissible: true,
    audience: { kind: 'everyone' },
    visibleFrom: '2000-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    sourceLocale: 'en',
    content: {
      en: { title: 'Hello', body: '', origin: 'source', sourceHash: 'x' },
      fr: { title: 'Bonjour', body: '', origin: 'ai', sourceHash: 'x' },
    },
    variables: [],
    ...STAMP,
    ...extra,
  };
}

async function get(query = '') {
  const { GET } = await import('@/app/api/version/route');
  const response = await GET(
    new NextRequest(new URL(`/api/version${query}`, 'http://localhost:3000')),
  );
  return { response, data: await response.json() };
}

describe('GET /api/version', () => {
  const originalEnv = process.env.NEXT_PUBLIC_BUILD;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NEXT_PUBLIC_BUILD = '42';
    mockAuth.mockResolvedValue({ user: { mail: 'a@ocp.msf.org' } });
    announcementsDocument.value = null;
    announcementsDocument.ensureFresh.mockResolvedValue(undefined);
    enabledDelegations.value = [];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_BUILD = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_BUILD;
    }
  });

  it('keeps `build` at the top level — old tabs read nothing else', async () => {
    const { response, data } = await get();
    expect(response.status).toBe(200);
    expect(data.build).toBe('42');
    expect(data.messages).toEqual([]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns "unknown" when NEXT_PUBLIC_BUILD is not set, and never reports an update then', async () => {
    delete process.env.NEXT_PUBLIC_BUILD;
    const { data } = await get('?build=41');
    expect(data.build).toBe('unknown');
    expect(data.messages).toEqual([]);
  });

  it('queues `update` only when the client sent a DIFFERENT build', async () => {
    expect((await get('?build=41')).data.messages).toEqual([
      { kind: 'update' },
    ]);
    expect((await get('?build=42')).data.messages).toEqual([]);
    // Old clients send no build: the server cannot know, and says nothing.
    expect((await get()).data.messages).toEqual([]);
    expect((await get('?build=unknown')).data.messages).toEqual([]);
  });

  it('NEVER 401s: without a session it answers the build and no announcements', async () => {
    mockAuth.mockResolvedValue(null);
    announcementsDocument.value = {
      announcements: [announcement()],
      allowedLinkHosts: [],
    };
    const { response, data } = await get('?build=41');
    expect(response.status).toBe(200);
    expect(data).toEqual({ build: '42', messages: [{ kind: 'update' }] });
    expect(announcementsDocument.ensureFresh).not.toHaveBeenCalled();
  });

  it('never fails because of announcements: the refresh message survives a storage outage', async () => {
    announcementsDocument.ensureFresh.mockRejectedValue(new Error('blob down'));
    const { response, data } = await get('?build=41');
    expect(response.status).toBe(200);
    expect(data.messages).toEqual([{ kind: 'update' }]);
  });

  it('queues the update first, then announcements in the reader’s language', async () => {
    announcementsDocument.value = {
      announcements: [announcement()],
      allowedLinkHosts: [],
    };
    const { data } = await get('?build=41&locale=fr');
    expect(data.messages.map((m: { kind: string }) => m.kind)).toEqual([
      'update',
      'announcement',
    ]);
    expect(data.messages[1].title).toBe('Bonjour');
    expect(JSON.stringify(data)).not.toContain('Hello');
  });

  it('falls back to English for an unsupported locale parameter', async () => {
    announcementsDocument.value = {
      announcements: [announcement()],
      allowedLinkHosts: [],
    };
    const { data } = await get('?locale=../../etc');
    expect(data.messages[0].title).toBe('Hello');
  });

  it('loads delegations only when something delegated could be delivered', async () => {
    announcementsDocument.value = {
      announcements: [announcement()],
      allowedLinkHosts: [],
    };
    await get();
    expect(delegationsEnsureFresh).not.toHaveBeenCalled();

    announcementsDocument.value = {
      announcements: [announcement({ delegationId: 'del-0000000000aa' })],
      allowedLinkHosts: [],
    };
    const { data } = await get();
    expect(delegationsEnsureFresh).toHaveBeenCalled();
    // No such enabled delegation → inert, never promoted to org-wide.
    expect(data.messages).toEqual([]);
  });
});
