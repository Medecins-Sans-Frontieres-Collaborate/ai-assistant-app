import { NextRequest } from 'next/server';

import {
  StoredAgentAccessRule,
  createAgentAccessBlobStorage,
  deleteRule,
  listAllRules,
  readConfig,
  writeHistoryEntry,
  writeRule,
} from '@/lib/services/agentAccess/accessRulesStore';
// Real error class for instanceof checks in the route.
import { AgentAccessConflictError } from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessRule,
  canonicalAgentKey,
  ruleBlobPath,
} from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from '../helpers';

import { DELETE, GET, PUT } from '@/app/api/agent-access/rules/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
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
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
      invalidate: serviceInvalidate,
    }),
  },
}));

// Keep AgentAccessConflictError (instanceof mapping to 409) real; mock only
// the blob accessors — same pattern as the backup-manifest route tests.
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
      listAllRules: vi.fn(),
      readConfig: vi.fn(),
      writeRule: vi.fn(),
      deleteRule: vi.fn(),
      writeHistoryEntry: vi.fn(),
    };
  },
);

const SOURCE =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';
const OTHER_SOURCE =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/other/projects/proj';
const KEY_A = canonicalAgentKey(SOURCE, 'agent-a');
const KEY_B = canonicalAgentKey(OTHER_SOURCE, 'agent-b');

const GLOBAL_SESSION = { user: { id: 'u-global', mail: 'global@example.com' } };
const LOCAL_SESSION = { user: { id: 'u-local', mail: 'local@example.com' } };
const USER_SESSION = { user: { id: 'u-plain', mail: 'user@example.com' } };

function makeRule(overrides: Partial<AgentAccessRule> = {}): AgentAccessRule {
  return {
    version: 1,
    source: SOURCE,
    agentName: 'agent-a',
    access: {
      type: 'restricted',
      allowDomains: ['example.com'],
      allowUsers: [],
      allowGroups: [],
    },
    updatedBy: 'global@example.com',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

function storedRule(
  canonicalKey: string,
  rule: AgentAccessRule,
  etag: string,
): StoredAgentAccessRule {
  return { canonicalKey, blobPath: ruleBlobPath(canonicalKey), rule, etag };
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    rules: [
      storedRule(KEY_A, makeRule(), '"e-a"'),
      storedRule(
        KEY_B,
        makeRule({ source: OTHER_SOURCE, agentName: 'agent-b' }),
        '"e-b"',
      ),
    ],
    // Local admin is delegated KEY_A only (entry deliberately un-normalized
    // to exercise the canonicalized comparison).
    config: {
      version: 1,
      localAdmins: [
        {
          email: ' Local@Example.com ',
          agentKeys: [` ${KEY_A.toUpperCase()} `],
        },
      ],
      updatedBy: 'global@example.com',
      updatedAt: '2026-07-17T00:00:00.000Z',
    },
    configEtag: '"cfg-e1"',
    rulesUnavailable: false,
    fetchedAt: 1,
    ...overrides,
  };
}

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/agent-access/rules', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

function deleteRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  const search = new URLSearchParams(params).toString();
  return new NextRequest(
    `http://localhost:3000/api/agent-access/rules?${search}`,
    { method: 'DELETE', headers },
  );
}

const putBody = {
  source: SOURCE,
  agentName: 'agent-a',
  access: { type: 'restricted', allowUsers: ['a@example.com'] },
};

describe('/api/agent-access/rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    serviceIsEnabled.mockReturnValue(true);
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceGetSnapshot.mockReturnValue(makeSnapshot());
    mockAuth.mockResolvedValue(GLOBAL_SESSION);
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as any);
    // GET reads storage directly — give it fresher etags than the snapshot
    // so tests can prove which source the response came from.
    vi.mocked(listAllRules).mockResolvedValue([
      storedRule(KEY_A, makeRule(), '"fresh-a"'),
      storedRule(
        KEY_B,
        makeRule({ source: OTHER_SOURCE, agentName: 'agent-b' }),
        '"fresh-b"',
      ),
    ]);
    vi.mocked(readConfig).mockResolvedValue({
      config: makeSnapshot().config as any,
      etag: '"cfg-fresh"',
    });
    vi.mocked(writeRule).mockResolvedValue('"e-new"');
    vi.mocked(deleteRule).mockResolvedValue(true);
    vi.mocked(writeHistoryEntry).mockResolvedValue(undefined);
  });

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(401);
      expect(listAllRules).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(listAllRules).not.toHaveBeenCalled();
    });

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await GET();

      expect(response.status).toBe(403);
    });

    it('reads storage directly and returns FRESH etags, not the stale snapshot', async () => {
      // The snapshot (≤60s stale) still holds the old etags; the response
      // must carry the storage etags or the 409-reload flow loops forever.
      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.rules).toEqual([
        { canonicalKey: KEY_A, rule: makeRule(), etag: '"fresh-a"' },
        {
          canonicalKey: KEY_B,
          rule: makeRule({ source: OTHER_SOURCE, agentName: 'agent-b' }),
          etag: '"fresh-b"',
        },
      ]);
      expect(data.data.rulesUnavailable).toBe(false);
      expect(typeof data.data.fetchedAt).toBe('number');
      expect(listAllRules).toHaveBeenCalled();
      expect(readConfig).toHaveBeenCalled();
      // Never consults the cached snapshot for the listing.
      expect(serviceGetSnapshot).not.toHaveBeenCalled();
    });

    it('filters the listing to delegated keys for a local admin (config from storage)', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.rules).toHaveLength(1);
      expect(data.data.rules[0].canonicalKey).toBe(KEY_A);
      expect(data.data.rules[0].etag).toBe('"fresh-a"');
    });

    it('reports rulesUnavailable on storage failure instead of a 500', async () => {
      vi.mocked(listAllRules).mockRejectedValue(new Error('blob down'));

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.rules).toEqual([]);
      expect(data.data.rulesUnavailable).toBe(true);
      expect(data.data.fetchedAt).toBeNull();
    });

    it('returns 403 for a local admin when the config could not be read', async () => {
      // Without config there is no proof of delegation — fail closed.
      mockAuth.mockResolvedValue(LOCAL_SESSION);
      vi.mocked(readConfig).mockRejectedValue(new Error('blob down'));

      const response = await GET();

      expect(response.status).toBe(403);
    });
  });

  describe('PUT', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(401);
      expect(writeRule).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(writeRule).not.toHaveBeenCalled();
    });

    it('returns 403 when the session has no Graph mail', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'u-x', mail: undefined } });

      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(403);
      expect(writeRule).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON', async () => {
      const response = await PUT(putRequest('{not json'));

      expect(response.status).toBe(400);
      expect(writeRule).not.toHaveBeenCalled();
    });

    it.each([
      ['missing source', { agentName: 'a', access: { type: 'public' } }],
      [
        'empty agentName',
        { source: SOURCE, agentName: '', access: { type: 'public' } },
      ],
      [
        // Whitespace-only values canonicalize to an empty key — an
        // undeletable rule that also matches every unresolved-source
        // invocation of that agent name. Must never mint.
        'whitespace-only source',
        { source: '   ', agentName: 'a', access: { type: 'public' } },
      ],
      [
        'whitespace-only agentName',
        { source: SOURCE, agentName: ' \t ', access: { type: 'public' } },
      ],
      [
        'bad access type',
        { source: SOURCE, agentName: 'a', access: { type: 'secret' } },
      ],
      ['missing access', { source: SOURCE, agentName: 'a' }],
      [
        'source over 1024 chars',
        {
          source: 'x'.repeat(1025),
          agentName: 'a',
          access: { type: 'public' },
        },
      ],
      [
        'agentName over 256 chars',
        {
          source: SOURCE,
          agentName: 'x'.repeat(257),
          access: { type: 'public' },
        },
      ],
      [
        'allowDomains entry over 255 chars',
        {
          source: SOURCE,
          agentName: 'a',
          access: { type: 'restricted', allowDomains: ['d'.repeat(256)] },
        },
      ],
      [
        'more than 500 allowDomains',
        {
          source: SOURCE,
          agentName: 'a',
          access: {
            type: 'restricted',
            allowDomains: Array.from({ length: 501 }, (_, i) => `d${i}.com`),
          },
        },
      ],
      [
        'allowUsers entry over 320 chars',
        {
          source: SOURCE,
          agentName: 'a',
          access: { type: 'restricted', allowUsers: ['u'.repeat(321)] },
        },
      ],
      [
        'more than 2000 allowUsers',
        {
          source: SOURCE,
          agentName: 'a',
          access: {
            type: 'restricted',
            allowUsers: Array.from({ length: 2001 }, (_, i) => `u${i}@x.com`),
          },
        },
      ],
      [
        'allowGroups entry over 320 chars',
        {
          source: SOURCE,
          agentName: 'a',
          access: { type: 'restricted', allowGroups: ['g'.repeat(321)] },
        },
      ],
      [
        'more than 500 allowGroups',
        {
          source: SOURCE,
          agentName: 'a',
          access: {
            type: 'restricted',
            allowGroups: Array.from({ length: 501 }, (_, i) => `g${i}`),
          },
        },
      ],
    ])('returns 400 for shape violation: %s', async (_label, body) => {
      const response = await PUT(putRequest(body));

      expect(response.status).toBe(400);
      expect(writeRule).not.toHaveBeenCalled();
    });

    it.each([['*'], ['W/"weak"'], ['unquoted']])(
      'rejects a non-strong-ETag If-Match header (%s) before any write',
      async (ifMatch) => {
        const response = await PUT(
          putRequest(putBody, { 'if-match': ifMatch }),
        );

        expect(response.status).toBe(400);
        expect(writeRule).not.toHaveBeenCalled();
      },
    );

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(403);
      expect(writeRule).not.toHaveBeenCalled();
    });

    it('returns 403 for a local admin writing a non-delegated key', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await PUT(
        putRequest(
          { ...putBody, source: OTHER_SOURCE, agentName: 'agent-b' },
          { 'if-match': '"e-b"' },
        ),
      );

      expect(response.status).toBe(403);
      expect(writeRule).not.toHaveBeenCalled();
    });

    it('allows a local admin to update a delegated key (case-variant input)', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      // Uppercase source + padded agentName must canonicalize onto the
      // delegated key — no case-variant authorization bypass.
      const response = await PUT(
        putRequest(
          { ...putBody, source: SOURCE.toUpperCase(), agentName: ' AGENT-A ' },
          { 'if-match': '"e-a"' },
        ),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ canonicalKey: KEY_A, etag: '"e-new"' });
      // Case is preserved for display, but padding is trimmed on write.
      expect(writeRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          source: SOURCE.toUpperCase(),
          agentName: 'AGENT-A',
          updatedBy: 'local@example.com',
        }),
        '"e-a"',
      );
    });

    it('persists source and agentName trimmed', async () => {
      const response = await PUT(
        putRequest(
          { ...putBody, source: `  ${SOURCE}  `, agentName: '  agent-a  ' },
          { 'if-match': '"e-a"' },
        ),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.canonicalKey).toBe(KEY_A);
      expect(writeRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ source: SOURCE, agentName: 'agent-a' }),
        '"e-a"',
      );
    });

    it('lets a global admin upsert any key, invalidates cache and appends history', async () => {
      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ canonicalKey: KEY_A, etag: '"e-new"' });
      expect(writeRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          source: SOURCE,
          agentName: 'agent-a',
          access: expect.objectContaining({
            type: 'restricted',
            allowUsers: ['a@example.com'],
          }),
          updatedBy: 'global@example.com',
        }),
        '"e-a"',
      );
      expect(serviceInvalidate).toHaveBeenCalled();
      expect(writeHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          canonicalKey: KEY_A,
          action: 'upsert',
          rule: expect.objectContaining({ agentName: 'agent-a' }),
          updatedBy: 'global@example.com',
        }),
      );
    });

    it('treats a missing If-Match as create-only (null etag to the store)', async () => {
      const response = await PUT(putRequest(putBody));

      expect(response.status).toBe(200);
      expect(writeRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        null,
      );
    });

    it('maps a lost CAS race to 409 AGENT_ACCESS_CONFLICT and invalidates the cache', async () => {
      vi.mocked(writeRule).mockRejectedValue(new AgentAccessConflictError());

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('AGENT_ACCESS_CONFLICT');
      // A 412 proves another replica just wrote — this replica must refresh
      // its enforcement state promptly rather than serve it stale for ≤60s.
      expect(serviceInvalidate).toHaveBeenCalled();
    });

    it('does not fail the response when the history append fails', async () => {
      // The rule mutation has already landed; converting it into an error
      // would make the client retry with a now-stale If-Match and 409.
      vi.mocked(writeHistoryEntry).mockRejectedValue(new Error('blob down'));

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(200);
      expect(serviceInvalidate).toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    const params = { source: SOURCE, agentName: 'agent-a' };

    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(401);
      expect(deleteRule).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(deleteRule).not.toHaveBeenCalled();
    });

    it('returns 400 when source or agentName is missing', async () => {
      const response = await DELETE(
        deleteRequest({ source: SOURCE }, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(400);
      expect(deleteRule).not.toHaveBeenCalled();
    });

    it.each([[undefined], ['*'], ['W/"weak"'], ['unquoted']])(
      'requires a quoted strong-ETag If-Match (%s)',
      async (ifMatch) => {
        const response = await DELETE(
          deleteRequest(params, ifMatch ? { 'if-match': ifMatch } : {}),
        );

        expect(response.status).toBe(400);
        expect(deleteRule).not.toHaveBeenCalled();
      },
    );

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(403);
      expect(deleteRule).not.toHaveBeenCalled();
    });

    it('returns 403 for a local admin deleting a non-delegated key', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await DELETE(
        deleteRequest(
          { source: OTHER_SOURCE, agentName: 'agent-b' },
          { 'if-match': '"e-b"' },
        ),
      );

      expect(response.status).toBe(403);
      expect(deleteRule).not.toHaveBeenCalled();
    });

    it('lets a local admin delete a delegated key and writes a tombstone', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ canonicalKey: KEY_A, deleted: true });
      expect(deleteRule).toHaveBeenCalledWith(
        expect.anything(),
        KEY_A,
        '"e-a"',
      );
      expect(serviceInvalidate).toHaveBeenCalled();
      expect(writeHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          canonicalKey: KEY_A,
          action: 'delete',
          rule: null,
          updatedBy: 'local@example.com',
        }),
      );
    });

    it('returns 404 when the rule is already absent', async () => {
      vi.mocked(deleteRule).mockResolvedValue(false);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(404);
      expect(serviceInvalidate).not.toHaveBeenCalled();
      expect(writeHistoryEntry).not.toHaveBeenCalled();
    });

    it('maps a lost CAS race to 409 AGENT_ACCESS_CONFLICT and invalidates the cache', async () => {
      vi.mocked(deleteRule).mockRejectedValue(new AgentAccessConflictError());

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
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
