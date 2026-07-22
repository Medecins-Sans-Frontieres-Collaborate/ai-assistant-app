import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readConfig,
  writeConfig,
} from '@/lib/services/agentAccess/accessRulesStore';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/accessRulesStore';
import { canonicalAgentKey } from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import { GET, PUT } from '@/app/api/agent-access/config/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      invalidate: serviceInvalidate,
    }),
  },
}));

// Keep AgentAccessConflictError real (instanceof → 409); mock blob accessors.
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return {
      ...actual,
      createAgentAccessBlobStorage: vi.fn(),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };
  },
);

const SOURCE =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';
const KEY_A = canonicalAgentKey(SOURCE, 'agent-a');

const GLOBAL_SESSION = { user: { id: 'u-global', mail: 'global@example.com' } };
// Local admins can never touch the delegation map, delegated keys or not.
const LOCAL_SESSION = { user: { id: 'u-local', mail: 'local@example.com' } };

const storedConfig = {
  version: 1,
  localAdmins: [{ email: 'local@example.com', agentKeys: [KEY_A] }],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/agent-access/config', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

const putBody = {
  localAdmins: [{ email: 'lead@example.com', agentKeys: [KEY_A] }],
};

describe('/api/agent-access/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    serviceIsEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue(GLOBAL_SESSION);
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as any);
    vi.mocked(readConfig).mockResolvedValue({
      config: storedConfig,
      etag: '"cfg-e1"',
    });
    vi.mocked(writeConfig).mockResolvedValue('"cfg-e2"');
  });

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(401);
      expect(readConfig).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(readConfig).not.toHaveBeenCalled();
    });

    it('returns 403 for a local admin (global-only surface)', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await GET();

      expect(response.status).toBe(403);
      expect(readConfig).not.toHaveBeenCalled();
    });

    it('reads storage directly and echoes the current config + etag', async () => {
      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ config: storedConfig, etag: '"cfg-e1"' });
    });

    it('returns null config + etag when no config.json exists yet', async () => {
      vi.mocked(readConfig).mockResolvedValue(null);

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ config: null, etag: null });
    });
  });

  describe('PUT', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(401);
      expect(writeConfig).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(writeConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['non-admin', { user: { id: 'u-x', mail: 'user@example.com' } }],
      ['local admin', LOCAL_SESSION],
      ['missing mail', { user: { id: 'u-x', mail: undefined } }],
    ])('returns 403 for %s', async (_label, session) => {
      mockAuth.mockResolvedValue(session);

      const response = await PUT(
        putRequest(putBody, { 'if-match': '"cfg-e1"' }),
      );

      expect(response.status).toBe(403);
      expect(writeConfig).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON', async () => {
      const response = await PUT(putRequest('{not json'));

      expect(response.status).toBe(400);
      expect(writeConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['localAdmins not an array', { localAdmins: 'nope' }],
      ['entry missing email', { localAdmins: [{ agentKeys: [] }] }],
      ['empty email', { localAdmins: [{ email: '', agentKeys: [] }] }],
      [
        'non-string agentKeys',
        { localAdmins: [{ email: 'a@b.c', agentKeys: [1] }] },
      ],
      [
        'email over 320 chars',
        { localAdmins: [{ email: `${'e'.repeat(320)}@x.com`, agentKeys: [] }] },
      ],
      [
        'agentKeys entry over 1300 chars',
        { localAdmins: [{ email: 'a@b.c', agentKeys: ['k'.repeat(1301)] }] },
      ],
      [
        'more than 500 agentKeys',
        {
          localAdmins: [
            {
              email: 'a@b.c',
              agentKeys: Array.from({ length: 501 }, (_, i) => `key-${i}`),
            },
          ],
        },
      ],
      [
        'more than 500 localAdmins',
        {
          localAdmins: Array.from({ length: 501 }, (_, i) => ({
            email: `admin${i}@x.com`,
            agentKeys: [],
          })),
        },
      ],
    ])('returns 400 for shape violation: %s', async (_label, body) => {
      const response = await PUT(putRequest(body, { 'if-match': '"cfg-e1"' }));

      expect(response.status).toBe(400);
      expect(writeConfig).not.toHaveBeenCalled();
    });

    it.each([['*'], ['W/"weak"'], ['unquoted']])(
      'rejects a non-strong-ETag If-Match header (%s) before any write',
      async (ifMatch) => {
        const response = await PUT(
          putRequest(putBody, { 'if-match': ifMatch }),
        );

        expect(response.status).toBe(400);
        expect(writeConfig).not.toHaveBeenCalled();
      },
    );

    it('writes the config with If-Match CAS and invalidates the cache', async () => {
      const response = await PUT(
        putRequest(putBody, { 'if-match': '"cfg-e1"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ etag: '"cfg-e2"' });
      expect(writeConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          localAdmins: [{ email: 'lead@example.com', agentKeys: [KEY_A] }],
          updatedBy: 'global@example.com',
        }),
        '"cfg-e1"',
      );
      expect(serviceInvalidate).toHaveBeenCalled();
    });

    it('persists delegated agentKeys canonicalized (trim + lowercase)', async () => {
      // Enforcement compares canonicalized keys everywhere — the stored
      // config must hold exactly what enforcement matches on.
      const response = await PUT(
        putRequest(
          {
            localAdmins: [
              {
                email: 'lead@example.com',
                agentKeys: [` ${KEY_A.toUpperCase()} `],
              },
            ],
          },
          { 'if-match': '"cfg-e1"' },
        ),
      );

      expect(response.status).toBe(200);
      expect(writeConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          localAdmins: [{ email: 'lead@example.com', agentKeys: [KEY_A] }],
        }),
        '"cfg-e1"',
      );
    });

    it('treats a missing If-Match as create-only (null etag to the store)', async () => {
      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(200);
      expect(writeConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        null,
      );
    });

    it('maps a lost CAS race to 409 AGENT_ACCESS_CONFLICT and invalidates the cache', async () => {
      vi.mocked(writeConfig).mockRejectedValue(new AgentAccessConflictError());

      const response = await PUT(
        putRequest(putBody, { 'if-match': '"cfg-e1"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('AGENT_ACCESS_CONFLICT');
      // A 412 proves another replica just wrote — this replica must refresh
      // its enforcement state promptly rather than serve it stale for ≤60s.
      expect(serviceInvalidate).toHaveBeenCalled();
    });
  });
});
