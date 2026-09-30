/**
 * /api/admin/announcements (+ /[id], /allowed-hosts): who may see and write
 * what, single-record writes under CAS, and the "approve the host this
 * message links to" shortcut.
 */
import { NextRequest } from 'next/server';

import { ANNOUNCEMENTS_DOCUMENT_PATH } from '@/lib/services/announcements/types';

import { parseJsonResponse } from '../helpers';
import { BlobFake, installBlobFake } from './blobFake';

import {
  DELETE as DELETE_ONE,
  PUT as PUT_ONE,
} from '@/app/api/admin/announcements/[id]/route';
import {
  POST as ALLOW_HOST,
  DELETE as REMOVE_HOST,
} from '@/app/api/admin/announcements/allowed-hosts/route';
import { GET, POST } from '@/app/api/admin/announcements/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const delegationsSnapshot = vi.hoisted(() => ({
  document: null as unknown,
  etag: null,
  unavailable: false,
}));
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({}),
}));
vi.mock('@/lib/services/delegations/DelegationsService', () => ({
  DelegationsService: {
    getInstance: () => ({
      ensureFresh: vi.fn(),
      getSnapshot: () => delegationsSnapshot,
    }),
  },
}));
vi.mock('@/lib/services/announcements/AnnouncementsService', () => ({
  AnnouncementsService: { getInstance: () => ({ invalidate: vi.fn() }) },
}));
vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, downloadBlob: vi.fn(), uploadJson: vi.fn() };
});

const DEL_OCP = 'del-0000000000aa';
const DEL_OCB = 'del-0000000000bb';
const STAMP = {
  createdBy: 'g',
  createdAt: 'x',
  updatedBy: 'g',
  updatedAt: 'x',
};
const GLOBAL = { user: { id: 'g', mail: 'global@example.com' } };
const OCP_SENDER = { user: { id: 's', mail: 'sender@ocp.msf.org' } };
const NOBODY = { user: { id: 'n', mail: 'nobody@ocp.msf.org' } };

function delegation(id: string, admin: string) {
  return {
    id,
    label: id === DEL_OCP ? 'OCP' : 'OCB',
    enabled: true,
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    capabilities: ['announcements'],
    admins: [{ mail: admin, grants: ['announcements'] }],
    limits: { maxOverrides: 25 },
    ...STAMP,
  };
}

function stored(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    revision: 1,
    status: 'draft',
    severity: 'info',
    dismissible: true,
    audience: { kind: 'everyone' },
    visibleFrom: '2026-10-10T00:00:00.000Z',
    expiresAt: '2026-10-12T00:00:00.000Z',
    sourceLocale: 'en',
    content: {
      en: { title: id, body: '', origin: 'source', sourceHash: 'x' },
    },
    variables: [],
    ...STAMP,
    ...extra,
  };
}

const OCP_ANN = 'ann-0000000000a1';
const OCB_ANN = 'ann-0000000000b1';
const GLOBAL_ANN = 'ann-0000000000c1';

const writeBody = (extra: Record<string, unknown> = {}) => ({
  status: 'draft',
  audience: { kind: 'everyone' },
  visibleFrom: '2026-10-10T00:00:00.000Z',
  expiresAt: '2026-10-12T00:00:00.000Z',
  sourceLocale: 'en',
  content: { en: { title: 'Maintenance', body: '', origin: 'source' } },
  ...extra,
});

const request = (method: string, body?: unknown, url = 'http://localhost/x') =>
  new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let blobs: BlobFake;
const document = () =>
  blobs.read<{
    announcements: Array<Record<string, any>>;
    allowedLinkHosts: string[];
  }>(ANNOUNCEMENTS_DOCUMENT_PATH)!;

describe('/api/admin/announcements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    blobs = installBlobFake();
    delegationsSnapshot.document = {
      delegations: [
        delegation(DEL_OCP, 'sender@ocp.msf.org'),
        delegation(DEL_OCB, 'other@ocb.msf.org'),
      ],
    };
    blobs.seed(ANNOUNCEMENTS_DOCUMENT_PATH, {
      version: 1,
      announcements: [
        stored(OCP_ANN, { delegationId: DEL_OCP }),
        stored(OCB_ANN, { delegationId: DEL_OCB }),
        stored(GLOBAL_ANN),
      ],
      allowedLinkHosts: [],
      updatedBy: 'g',
      updatedAt: 'x',
    });
    mockAuth.mockResolvedValue(GLOBAL);
  });

  describe('who sees what', () => {
    it('401 without a session, 403 without the grant', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
      mockAuth.mockResolvedValue(NOBODY);
      expect((await GET()).status).toBe(403);
      expect((await POST(request('POST', writeBody()))).status).toBe(403);
    });

    it('a global admin sees everything; a delegated sender ONLY their delegations’ records — filtered server-side', async () => {
      const all = await parseJsonResponse(await GET());
      expect(all.data.announcements).toHaveLength(3);
      expect(all.data.isGlobalAdmin).toBe(true);

      mockAuth.mockResolvedValue(OCP_SENDER);
      const mine = await parseJsonResponse(await GET());
      expect(mine.data.announcements.map((a: { id: string }) => a.id)).toEqual([
        OCP_ANN,
      ]);
      expect(mine.data.delegations.map((d: { id: string }) => d.id)).toEqual([
        DEL_OCP,
      ]);
      // Admin rosters of delegations never reach a delegated sender.
      expect(JSON.stringify(mine.data)).not.toContain('other@ocb.msf.org');
    });
  });

  describe('create', () => {
    it('a delegated sender creates under their delegation, and nowhere else (uniform 403)', async () => {
      mockAuth.mockResolvedValue(OCP_SENDER);
      const ok = await POST(
        request('POST', writeBody({ delegationId: DEL_OCP })),
      );
      expect(ok.status).toBe(200);
      const created = (await parseJsonResponse(ok)).data.announcement;
      expect(created.id).toMatch(/^ann-[0-9a-f]{12}$/);
      expect(created.delegationId).toBe(DEL_OCP);
      expect(created.createdBy).toBe('sender@ocp.msf.org');
      expect(document().announcements).toHaveLength(4);

      for (const delegationId of [undefined, DEL_OCB, 'del-ffffffffffff']) {
        const refused = await POST(
          request('POST', writeBody({ delegationId })),
        );
        expect(refused.status).toBe(403);
      }
      expect(document().announcements).toHaveLength(4);
    });

    it('maps a validation problem to its code without writing', async () => {
      const response = await POST(
        request('POST', writeBody({ status: 'published' })),
      );
      expect(response.status).toBe(400);
      expect((await parseJsonResponse(response)).code).toBe(
        'ANNOUNCEMENT_CONFIRM_EVERYONE',
      );
      expect(document().announcements).toHaveLength(3);
    });

    it('rejects unknown keys (strict body)', async () => {
      const response = await POST(
        request('POST', writeBody({ createdBy: 'attacker@x.org' })),
      );
      expect(response.status).toBe(400);
    });
  });

  describe('update / delete one record', () => {
    it('a delegated sender cannot tell a foreign record from an unknown one — both 403, nothing written', async () => {
      mockAuth.mockResolvedValue(OCP_SENDER);
      for (const id of [OCB_ANN, GLOBAL_ANN, 'ann-ffffffffffff']) {
        const put = await PUT_ONE(request('PUT', writeBody()), params(id));
        expect(put.status).toBe(403);
        const del = await DELETE_ONE(request('DELETE'), params(id));
        expect(del.status).toBe(403);
      }
      expect(document().announcements).toHaveLength(3);
      expect(document().announcements[1].content.en.title).toBe(OCB_ANN);
    });

    it('a global admin gets a 404 for an unknown id', async () => {
      const response = await PUT_ONE(
        request('PUT', writeBody()),
        params('ann-ffffffffffff'),
      );
      expect(response.status).toBe(404);
    });

    it('an edit cannot move a record to another delegation or to the global tier', async () => {
      mockAuth.mockResolvedValue(OCP_SENDER);
      const response = await PUT_ONE(
        request('PUT', writeBody({ delegationId: DEL_OCB })),
        params(OCP_ANN),
      );
      expect(response.status).toBe(200);
      expect(document().announcements[0].delegationId).toBe(DEL_OCP);
    });

    it('replaces exactly one record and leaves its neighbours untouched', async () => {
      const before = document().announcements;
      const response = await PUT_ONE(
        request(
          'PUT',
          writeBody({
            content: { en: { title: 'Edited', body: '', origin: 'source' } },
          }),
        ),
        params(GLOBAL_ANN),
      );
      expect(response.status).toBe(200);
      const after = document().announcements;
      expect(after[2].content.en.title).toBe('Edited');
      expect(after[0]).toEqual(before[0]);
      expect(after[1]).toEqual(before[1]);
    });

    it('deletes an owned record', async () => {
      mockAuth.mockResolvedValue(OCP_SENDER);
      expect(
        (await DELETE_ONE(request('DELETE'), params(OCP_ANN))).status,
      ).toBe(200);
      expect(document().announcements.map((a) => a.id)).toEqual([
        OCB_ANN,
        GLOBAL_ANN,
      ]);
    });
  });

  describe('link host allow-list', () => {
    const linkedDraft = writeBody({
      delegationId: DEL_OCP,
      action: { url: 'https://Wiki.Example.org/page?x=1' },
      content: {
        en: {
          title: 'Read this',
          body: '',
          actionLabel: 'Open',
          origin: 'source',
        },
      },
    });

    it('is managed by global admins only', async () => {
      mockAuth.mockResolvedValue(OCP_SENDER);
      expect(
        (await ALLOW_HOST(request('POST', { host: 'wiki.example.org' })))
          .status,
      ).toBe(403);
    });

    it('approves the host of a STORED message with one call, unblocking its publication', async () => {
      // 1. The sender saves a draft linking to an unapproved host…
      mockAuth.mockResolvedValue(OCP_SENDER);
      const draft = await POST(request('POST', linkedDraft));
      const id = (await parseJsonResponse(draft)).data.announcement.id;
      // …and cannot publish it yet.
      const blocked = await PUT_ONE(
        request('PUT', { ...linkedDraft, status: 'published' }),
        params(id),
      );
      expect((await parseJsonResponse(blocked)).code).toBe(
        'ANNOUNCEMENT_HOST_NOT_ALLOWED',
      );

      // 2. A global admin approves the host FROM that message.
      mockAuth.mockResolvedValue(GLOBAL);
      const approved = await ALLOW_HOST(
        request('POST', { announcementId: id }),
      );
      expect(approved.status).toBe(200);
      expect((await parseJsonResponse(approved)).data.host).toBe(
        'wiki.example.org',
      );
      expect(document().allowedLinkHosts).toEqual(['wiki.example.org']);

      // 3. The sender can now publish.
      mockAuth.mockResolvedValue(OCP_SENDER);
      const published = await PUT_ONE(
        request('PUT', { ...linkedDraft, status: 'published' }),
        params(id),
      );
      expect(published.status).toBe(200);
    });

    it('takes the host from the stored record, never from the request', async () => {
      const response = await ALLOW_HOST(
        request('POST', { announcementId: GLOBAL_ANN, host: 'evil.example' }),
      );
      expect(response.status).toBe(400);
      const noLink = await ALLOW_HOST(
        request('POST', { announcementId: GLOBAL_ANN }),
      );
      expect(noLink.status).toBe(400);
      expect(document().allowedLinkHosts).toEqual([]);
    });

    it('validates a manual host, is idempotent, and removes', async () => {
      for (const host of ['not a host', 'https://x.org/path', 'localhost']) {
        expect((await ALLOW_HOST(request('POST', { host }))).status).toBe(400);
      }
      await ALLOW_HOST(request('POST', { host: ' Wiki.Example.ORG ' }));
      await ALLOW_HOST(request('POST', { host: 'wiki.example.org' }));
      expect(document().allowedLinkHosts).toEqual(['wiki.example.org']);

      await REMOVE_HOST(
        request(
          'DELETE',
          undefined,
          'http://localhost/x?host=wiki.example.org',
        ),
      );
      expect(document().allowedLinkHosts).toEqual([]);
    });
  });
});
