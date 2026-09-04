import { NextRequest } from 'next/server';

import {
  __resetGlobalAdminSnapshotForTests,
  publishGlobalAdminSnapshot,
} from '@/lib/services/admin/globalAdminsSnapshot';
import {
  GlobalAdminsConflictError,
  createGlobalAdminsBlobStorage,
  readGlobalAdmins,
  writeGlobalAdmins,
  writeGlobalAdminsHistoryEntry,
} from '@/lib/services/admin/globalAdminsStore';

import { parseJsonResponse } from '../helpers';

import { GET, PUT } from '@/app/api/admin/global-admins/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const rosterEnsureFresh = vi.hoisted(() => vi.fn());
const rosterInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com' as string | undefined,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/admin/GlobalAdminRosterService', () => ({
  GlobalAdminRosterService: {
    getInstance: () => ({
      ensureFresh: rosterEnsureFresh,
      invalidate: rosterInvalidate,
    }),
  },
}));

// Keep GlobalAdminsConflictError real (instanceof → 409); mock blob accessors.
vi.mock('@/lib/services/admin/globalAdminsStore', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/admin/globalAdminsStore')
    >();
  return {
    ...actual,
    createGlobalAdminsBlobStorage: vi.fn(),
    readGlobalAdmins: vi.fn(),
    writeGlobalAdmins: vi.fn(),
    writeGlobalAdminsHistoryEntry: vi.fn(),
  };
});

const GLOBAL_SESSION = { user: { id: 'u-global', mail: 'global@example.com' } };
const USER_SESSION = { user: { id: 'u-user', mail: 'user@example.com' } };
const DEMOTED_SESSION = {
  user: {
    id: 'u-global',
    mail: 'global@example.com',
    viewAs: { overrides: { adminRole: 'none' } },
  },
};

const storedRoster = {
  version: 1,
  admins: ['config@example.com'],
  updatedBy: 'global@example.com',
  updatedAt: '2026-09-04T00:00:00.000Z',
};

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/global-admins', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

describe('/api/admin/global-admins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetGlobalAdminSnapshotForTests();
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    mockAuth.mockResolvedValue(GLOBAL_SESSION);
    rosterEnsureFresh.mockResolvedValue(undefined);
    vi.mocked(createGlobalAdminsBlobStorage).mockReturnValue({} as never);
    vi.mocked(readGlobalAdmins).mockResolvedValue({
      roster: storedRoster,
      etag: '"r-e1"',
    });
    vi.mocked(writeGlobalAdmins).mockResolvedValue('"r-e2"');
    vi.mocked(writeGlobalAdminsHistoryEntry).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(401);
      expect(readGlobalAdmins).not.toHaveBeenCalled();
    });

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await GET();

      expect(response.status).toBe(403);
      expect(readGlobalAdmins).not.toHaveBeenCalled();
    });

    it('returns 403 for a view-as-demoted global admin (effective identity)', async () => {
      mockAuth.mockResolvedValue(DEMOTED_SESSION);

      const response = await GET();

      expect(response.status).toBe(403);
    });

    it('admits a config-roster admin (env ∪ snapshot), reads storage directly, echoes roster + etag + env admins', async () => {
      mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com, Second@Example.com';
      publishGlobalAdminSnapshot(['config@example.com']);
      mockAuth.mockResolvedValue({
        user: { id: 'u-config', mail: 'Config@Example.com' },
      });

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(rosterEnsureFresh).toHaveBeenCalled();
      expect(data.data).toEqual({
        roster: storedRoster,
        etag: '"r-e1"',
        envAdmins: ['global@example.com', 'second@example.com'],
      });
    });

    it('returns null roster + etag when no roster has been authored yet', async () => {
      vi.mocked(readGlobalAdmins).mockResolvedValue(null);

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({
        roster: null,
        etag: null,
        envAdmins: ['global@example.com'],
      });
    });

    it('answers 500 (not a silent empty roster) when storage is unreadable', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(readGlobalAdmins).mockRejectedValue(new Error('storage down'));

      const response = await GET();

      expect(response.status).toBe(500);
    });
  });

  describe('PUT', () => {
    const body = { admins: ['New@Example.com', 'config@example.com'] };

    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(body));

      expect(response.status).toBe(401);
      expect(writeGlobalAdmins).not.toHaveBeenCalled();
    });

    it('returns 403 for a non-admin and for a demoted admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);
      expect((await PUT(putRequest(body))).status).toBe(403);

      mockAuth.mockResolvedValue(DEMOTED_SESSION);
      expect((await PUT(putRequest(body))).status).toBe(403);

      expect(writeGlobalAdmins).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON', async () => {
      const response = await PUT(putRequest('{not json'));

      expect(response.status).toBe(400);
      expect(writeGlobalAdmins).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-mail entry', { admins: ['not-a-mail'] }],
      ['an unknown key (strict)', { admins: ['a@x.org'], version: 1 }],
      ['a missing admins key', {}],
      [
        'too many admins',
        { admins: Array.from({ length: 201 }, (_, i) => `a${i}@x.org`) },
      ],
    ])('returns 400 for %s', async (_label, invalid) => {
      const response = await PUT(putRequest(invalid));

      expect(response.status).toBe(400);
      expect(writeGlobalAdmins).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-strong If-Match', async () => {
      for (const ifMatch of ['*', 'W/"weak"', 'unquoted']) {
        const response = await PUT(putRequest(body, { 'If-Match': ifMatch }));
        expect(response.status).toBe(400);
      }
      expect(writeGlobalAdmins).not.toHaveBeenCalled();
    });

    it('refuses to lock everyone out: empty admins while AGENT_ACCESS_ADMINS is empty → 400 GLOBAL_ADMINS_LOCKOUT', async () => {
      mockEnv.AGENT_ACCESS_ADMINS = undefined;
      // The caller is a config admin (env is empty), trying to empty the roster.
      publishGlobalAdminSnapshot(['global@example.com']);

      const response = await PUT(
        putRequest({ admins: [] }, { 'If-Match': '"r-e1"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.code).toBe('GLOBAL_ADMINS_LOCKOUT');
      expect(writeGlobalAdmins).not.toHaveBeenCalled();
    });

    it('allows an empty config roster while the env bootstrap is populated', async () => {
      const response = await PUT(
        putRequest({ admins: [] }, { 'If-Match': '"r-e1"' }),
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(writeGlobalAdmins).mock.calls[0][1].admins).toEqual([]);
    });

    it('allows a non-empty roster while the env bootstrap is empty', async () => {
      mockEnv.AGENT_ACCESS_ADMINS = undefined;
      publishGlobalAdminSnapshot(['global@example.com']);

      const response = await PUT(
        putRequest(
          { admins: ['global@example.com'] },
          { 'If-Match': '"r-e1"' },
        ),
      );

      expect(response.status).toBe(200);
    });

    it('normalizes + dedupes mails, stamps the author, passes If-Match to the CAS write, invalidates, and writes history', async () => {
      const response = await PUT(
        putRequest(
          {
            admins: [
              ' New@Example.com ',
              'new@example.com',
              'Config@Example.com',
            ],
          },
          { 'If-Match': '"r-e1"' },
        ),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ etag: '"r-e2"' });

      const [, written, ifMatch] = vi.mocked(writeGlobalAdmins).mock.calls[0];
      expect(written).toMatchObject({
        version: 1,
        admins: ['new@example.com', 'config@example.com'],
        updatedBy: 'global@example.com',
      });
      expect(typeof written.updatedAt).toBe('string');
      expect(ifMatch).toBe('"r-e1"');
      expect(rosterInvalidate).toHaveBeenCalledTimes(1);
      expect(writeGlobalAdminsHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          action: 'upsert',
          roster: written,
          updatedBy: 'global@example.com',
        }),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          '[global-admins] action=write count=2 by=global@example.com',
        ),
      );
    });

    it('creates (If-None-Match: *) when no If-Match is sent', async () => {
      await PUT(putRequest(body));

      expect(vi.mocked(writeGlobalAdmins).mock.calls[0][2]).toBeNull();
    });

    it('returns 409 GLOBAL_ADMINS_CONFLICT on a lost CAS race and invalidates the replica', async () => {
      vi.mocked(writeGlobalAdmins).mockRejectedValue(
        new GlobalAdminsConflictError(),
      );

      const response = await PUT(putRequest(body, { 'If-Match': '"r-e1"' }));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('GLOBAL_ADMINS_CONFLICT');
      expect(rosterInvalidate).toHaveBeenCalledTimes(1);
      expect(writeGlobalAdminsHistoryEntry).not.toHaveBeenCalled();
    });

    it('lets a config admin remove themselves while others remain, and warns about it', async () => {
      mockEnv.AGENT_ACCESS_ADMINS = undefined;
      publishGlobalAdminSnapshot(['global@example.com', 'other@example.com']);

      const response = await PUT(
        putRequest({ admins: ['other@example.com'] }, { 'If-Match': '"r-e1"' }),
      );

      expect(response.status).toBe(200);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('self-removal by=global@example.com'),
      );
    });

    it('does not warn about self-removal when the caller stays an env admin', async () => {
      await PUT(putRequest({ admins: [] }, { 'If-Match': '"r-e1"' }));

      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});
