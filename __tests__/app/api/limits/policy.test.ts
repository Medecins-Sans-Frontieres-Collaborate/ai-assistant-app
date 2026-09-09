import { NextRequest } from 'next/server';

import {
  createLimitsBlobStorage,
  readPolicy,
  writeHistoryEntry,
  writePolicy,
} from '@/lib/services/limits/limitsStore';
import {
  LimitDelegation,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';

import { parseJsonResponse } from '../helpers';

import { GET, PUT } from '@/app/api/limits/policy/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: {
    getInstance: () => ({
      invalidate: serviceInvalidate,
    }),
  },
}));

// Keep the conflict error class REAL so the instanceof → 409 mapping is
// genuinely exercised; mock only the blob accessors.
vi.mock('@/lib/services/limits/limitsStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/limits/limitsStore')>();
  return {
    ...actual,
    createLimitsBlobStorage: vi.fn(),
    readPolicy: vi.fn(),
    writePolicy: vi.fn(),
    writeHistoryEntry: vi.fn(),
  };
});

const globalAdminSession = {
  user: { id: 'oid-1', displayName: 'Global', mail: 'global@example.com' },
};
const normalSession = {
  user: { id: 'oid-2', displayName: 'User', mail: 'user@example.com' },
};

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/limits/policy', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const validBody = {
  defaults: [{ limitKey: 'chat.messagesPerDay', value: 100 }],
  overrides: [],
  mode: 'observe',
  failMode: 'open',
  timezone: 'UTC',
  countByomUsage: false,
  countAuxiliaryUsage: false,
};

const DEL_OCP = 'del-0000000000aa';
const STAMP = {
  createdBy: 'first-author@example.com',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedBy: 'someone@example.com',
  updatedAt: '2025-06-01T00:00:00.000Z',
};

function storedDelegation(
  extra: Partial<LimitDelegation> = {},
): LimitDelegation {
  return {
    id: DEL_OCP,
    label: 'OCP',
    enabled: true,
    admins: ['ocp-admin@ocp.msf.org'],
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    maxOverrides: 25,
    ...STAMP,
    ...extra,
  };
}

function storedOverride(
  id: string,
  extra: Partial<LimitOverride> = {},
): LimitOverride {
  return {
    id,
    label: '',
    enabled: true,
    scope: 'user',
    targets: ['a@ocp.msf.org'],
    priority: 0,
    entries: [],
    ...STAMP,
    ...extra,
  };
}

/** A stored read result, parsed through the real schema so defaults apply. */
function stored(input: Partial<LimitsPolicy>, etag = '"etag-1"') {
  return {
    policy: LimitsPolicySchema.parse({
      version: 1,
      ...validBody,
      updatedBy: 'someone@example.com',
      updatedAt: '2025-06-01T00:00:00.000Z',
      ...input,
    }),
    etag,
  };
}

const bodyDelegation = {
  id: DEL_OCP,
  label: 'OCP',
  enabled: true,
  admins: ['ocp-admin@ocp.msf.org'],
  jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
  maxOverrides: 25,
};

describe('/api/limits/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    mockAuth.mockResolvedValue(globalAdminSession);
    vi.mocked(createLimitsBlobStorage).mockReturnValue({} as never);
    // The PUT pre-reads the stored document; default to "none yet".
    vi.mocked(readPolicy).mockResolvedValue(null);
    vi.mocked(writePolicy).mockResolvedValue('"etag-new"');
    vi.mocked(writeHistoryEntry).mockResolvedValue(undefined);
  });

  describe('authorization', () => {
    it('401s without a session', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
    });

    it('403s for a non-global admin', async () => {
      mockAuth.mockResolvedValue(normalSession);
      expect((await GET()).status).toBe(403);
      expect((await PUT(putRequest(validBody))).status).toBe(403);
    });
  });

  describe('GET', () => {
    it('returns the stored policy and its ETag', async () => {
      vi.mocked(readPolicy).mockResolvedValue({
        policy: {
          ...validBody,
          version: 1,
          updatedBy: 'a',
          updatedAt: 'b',
        } as never,
        etag: '"etag-1"',
      });
      const body = await parseJsonResponse(await GET());
      expect(body.data.etag).toBe('"etag-1"');
      expect(body.data.policyUnavailable).toBe(false);
    });

    it('returns null policy when none has been authored', async () => {
      vi.mocked(readPolicy).mockResolvedValue(null);
      const body = await parseJsonResponse(await GET());
      expect(body.data.policy).toBeNull();
      expect(body.data.policyUnavailable).toBe(false);
    });

    it('reports policyUnavailable on a read failure — NEVER an empty policy', async () => {
      vi.mocked(readPolicy).mockRejectedValue(new Error('storage down'));
      const response = await GET();
      const body = await parseJsonResponse(response);
      // 200 with an explicit unavailable flag: rendering an outage as
      // "nothing configured" would tell an admin everything is unlimited.
      expect(response.status).toBe(200);
      expect(body.data.policyUnavailable).toBe(true);
      expect(body.data.policy).toBeNull();
    });
  });

  describe('PUT validation', () => {
    it('rejects an unknown limit key', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [{ limitKey: 'chat.notARealLimit', value: 5 }],
        }),
      );
      expect(response.status).toBe(400);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('rejects an entry carrying BOTH modelId and series', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [
            {
              limitKey: 'model.requests',
              modelId: 'gpt-5.2',
              series: 'gpt',
              value: 5,
            },
          ],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects a model qualifier on a non-per-model limit', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [
            { limitKey: 'chat.messagesPerDay', modelId: 'gpt-5.2', value: 5 },
          ],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects a path-traversal model qualifier', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          defaults: [
            { limitKey: 'model.requests', modelId: '../../etc', value: 5 },
          ],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects an unknown timezone rather than storing a silent UTC fallback', async () => {
      const response = await PUT(
        putRequest({ ...validBody, timezone: 'Not/AZone' }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects duplicate override ids', async () => {
      const override = {
        id: 'lim-0123456789ab',
        scope: 'user',
        targets: ['a@example.org'],
        entries: [],
      };
      const response = await PUT(
        putRequest({ ...validBody, overrides: [override, { ...override }] }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects more than 200 overrides', async () => {
      const overrides = Array.from({ length: 201 }, (_, i) => ({
        id: `lim-${i.toString(16).padStart(12, '0')}`,
        scope: 'user',
        targets: [`u${i}@example.org`],
        entries: [],
      }));
      const response = await PUT(putRequest({ ...validBody, overrides }));
      expect(response.status).toBe(400);
    });

    it('rejects a malformed If-Match header', async () => {
      const response = await PUT(putRequest(validBody, { 'if-match': '*' }));
      expect(response.status).toBe(400);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('rejects an invalid JSON body', async () => {
      const request = new NextRequest('http://localhost/api/limits/policy', {
        method: 'PUT',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      });
      expect((await PUT(request)).status).toBe(400);
    });
  });

  describe('PUT writes', () => {
    it('clamps a value above the compiled hardCeiling at the write boundary', async () => {
      await PUT(
        putRequest({
          ...validBody,
          defaults: [{ limitKey: 'feature.mcp.roundsPerRequest', value: 9999 }],
        }),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      // An admin must never see a stored number the resolver would silently
      // reduce.
      expect(written.defaults[0].value).toBe(25);
    });

    it('passes a quoted strong ETag through as the CAS condition', async () => {
      vi.mocked(readPolicy).mockResolvedValue(stored({}, '"etag-7"'));
      await PUT(putRequest(validBody, { 'if-match': '"etag-7"' }));
      expect(writePolicy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '"etag-7"',
      );
    });

    it('creates with a null ETag when If-Match is absent', async () => {
      await PUT(putRequest(validBody));
      expect(writePolicy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        null,
      );
    });

    it('writes a history entry and invalidates the cache after a successful write', async () => {
      await PUT(putRequest(validBody));
      expect(writeHistoryEntry).toHaveBeenCalledTimes(1);
      expect(serviceInvalidate).toHaveBeenCalledTimes(1);
    });

    it('maps a CAS conflict to 409 with LIMITS_CONFLICT', async () => {
      const { LimitsConflictError } = await vi.importActual<
        typeof import('@/lib/services/limits/limitsStore')
      >('@/lib/services/limits/limitsStore');
      vi.mocked(readPolicy).mockResolvedValue(stored({}, '"e"'));
      vi.mocked(writePolicy).mockRejectedValue(new LimitsConflictError());

      const response = await PUT(putRequest(validBody, { 'if-match': '"e"' }));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(409);
      expect(body.code).toBe('LIMITS_CONFLICT');
    });

    it('stamps the acting admin as updatedBy', async () => {
      await PUT(putRequest(validBody));
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.updatedBy).toBe('global@example.com');
    });

    it('preserves group-scoped overrides untouched even though they never evaluate', async () => {
      await PUT(
        putRequest({
          ...validBody,
          overrides: [
            {
              id: 'lim-0123456789ab',
              scope: 'group',
              targets: ['00000000-0000-0000-0000-000000000001'],
              entries: [{ limitKey: 'chat.messagesPerDay', value: 5 }],
            },
          ],
        }),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.overrides[0].scope).toBe('group');
      expect(written.overrides[0].targets).toEqual([
        '00000000-0000-0000-0000-000000000001',
      ]);
    });
  });
  describe('PUT pre-read: ETag compare comes FIRST (design §5)', () => {
    it('409s LIMITS_CONFLICT when If-Match differs from the stored ETag, before any write', async () => {
      vi.mocked(readPolicy).mockResolvedValue(stored({}, '"current"'));
      const response = await PUT(
        putRequest(validBody, { 'if-match': '"stale"' }),
      );
      expect(response.status).toBe(409);
      expect((await parseJsonResponse(response)).code).toBe('LIMITS_CONFLICT');
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('409s when If-Match is absent while a document exists', async () => {
      vi.mocked(readPolicy).mockResolvedValue(stored({}));
      const response = await PUT(putRequest(validBody));
      expect(response.status).toBe(409);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('409s when If-Match is given but no document exists yet', async () => {
      const response = await PUT(putRequest(validBody, { 'if-match': '"x"' }));
      expect(response.status).toBe(409);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('500s on a read failure rather than writing blind', async () => {
      vi.mocked(readPolicy).mockRejectedValue(new Error('storage down'));
      expect((await PUT(putRequest(validBody))).status).toBe(500);
      expect(writePolicy).not.toHaveBeenCalled();
    });
  });

  describe('PUT stale-client guard (design §9)', () => {
    it('409s with details "reload" when the body has NO delegations key but the store has delegations', async () => {
      vi.mocked(readPolicy).mockResolvedValue(
        stored({ delegations: [storedDelegation()] }),
      );
      // validBody predates delegations: no key at all.
      const response = await PUT(
        putRequest(validBody, { 'if-match': '"etag-1"' }),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(409);
      expect(body.code).toBe('LIMITS_CONFLICT');
      expect(body.details).toBe('reload');
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('treats an explicit `delegations: []` as a real delete when nothing references the delegation', async () => {
      vi.mocked(readPolicy).mockResolvedValue(
        stored({ delegations: [storedDelegation()] }),
      );
      const response = await PUT(
        putRequest(
          { ...validBody, delegations: [] },
          { 'if-match': '"etag-1"' },
        ),
      );
      expect(response.status).toBe(200);
      expect(vi.mocked(writePolicy).mock.calls[0][1].delegations).toEqual([]);
    });

    it('accepts a body without the key when the store has no delegations', async () => {
      vi.mocked(readPolicy).mockResolvedValue(stored({}));
      const response = await PUT(
        putRequest(validBody, { 'if-match': '"etag-1"' }),
      );
      expect(response.status).toBe(200);
      expect(vi.mocked(writePolicy).mock.calls[0][1].delegations).toEqual([]);
    });
  });

  describe('PUT ownership metadata (ADMIN_LIMITS_REVIEW #18)', () => {
    it('preserves createdBy/createdAt for an existing override id from STORAGE, ignoring the body, and stamps new ones', async () => {
      vi.mocked(readPolicy).mockResolvedValue(
        stored({ overrides: [storedOverride('lim-000000000001')] }),
      );
      const response = await PUT(
        putRequest(
          {
            ...validBody,
            overrides: [
              {
                id: 'lim-000000000001',
                scope: 'user',
                targets: ['a@ocp.msf.org'],
                entries: [],
                // A stale draft must not be able to rewrite ownership.
                createdBy: 'forged@example.com',
                createdAt: '1999-01-01T00:00:00.000Z',
              },
              {
                id: 'lim-000000000002',
                scope: 'user',
                targets: ['b@ocp.msf.org'],
                entries: [],
              },
            ],
          },
          { 'if-match': '"etag-1"' },
        ),
      );
      expect(response.status).toBe(200);
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.overrides[0]).toMatchObject({
        createdBy: 'first-author@example.com',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedBy: 'global@example.com',
      });
      expect(written.overrides[1].createdBy).toBe('global@example.com');
      expect(written.overrides[1].createdAt).toBe(written.updatedAt);
    });

    it('preserves createdBy/createdAt for an existing delegation id', async () => {
      vi.mocked(readPolicy).mockResolvedValue(
        stored({ delegations: [storedDelegation()] }),
      );
      await PUT(
        putRequest(
          { ...validBody, delegations: [{ ...bodyDelegation, label: 'new' }] },
          { 'if-match': '"etag-1"' },
        ),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.delegations[0]).toMatchObject({
        id: DEL_OCP,
        label: 'new',
        createdBy: 'first-author@example.com',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedBy: 'global@example.com',
      });
    });
  });

  describe('PUT delegations', () => {
    it('generates a server del- id and stamps createdBy for a delegation without an id; canonicalizes admins and targets', async () => {
      await PUT(
        putRequest({
          ...validBody,
          delegations: [
            {
              ...bodyDelegation,
              id: undefined,
              admins: [' OCP-Admin@ocp.msf.org ', 'ocp-admin@ocp.msf.org'],
              jurisdiction: [
                { scope: 'domain', targets: ['OCP.msf.org', ' ocp.msf.org'] },
              ],
            },
          ],
        }),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.delegations).toHaveLength(1);
      expect(written.delegations[0].id).toMatch(/^del-[0-9a-f]{12}$/);
      expect(written.delegations[0].createdBy).toBe('global@example.com');
      expect(written.delegations[0].admins).toEqual(['ocp-admin@ocp.msf.org']);
      expect(written.delegations[0].jurisdiction).toEqual([
        { scope: 'domain', targets: ['ocp.msf.org'] },
      ]);
    });

    it('rejects an unknown key, an oversized admins list, and an empty predicate (strict write schema)', async () => {
      for (const delegation of [
        { ...bodyDelegation, priority: 1 },
        {
          ...bodyDelegation,
          admins: Array.from({ length: 201 }, (_, i) => `a${i}@x.org`),
        },
        { ...bodyDelegation, jurisdiction: [{ scope: 'domain', targets: [] }] },
      ]) {
        const response = await PUT(
          putRequest({ ...validBody, delegations: [delegation] }),
        );
        expect(response.status).toBe(400);
      }
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('400s (with a `targets` issue, never a 500 from the read schema) for a whitespace-only jurisdiction target', async () => {
      vi.mocked(readPolicy).mockResolvedValue(stored({}));
      const response = await PUT(
        putRequest(
          {
            ...validBody,
            delegations: [
              {
                ...bodyDelegation,
                jurisdiction: [{ scope: 'domain', targets: ['   '] }],
              },
            ],
          },
          { 'if-match': '"etag-1"' },
        ),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(400);
      expect(body.code).toBe('BAD_REQUEST');
      expect(body.details).toContain('delegations.0.jurisdiction.0.targets');
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('never hands writePolicy a delegation the read schema would reject (whitespace admins are dropped, targets canonical)', async () => {
      vi.mocked(readPolicy).mockResolvedValue(stored({}));
      const response = await PUT(
        putRequest(
          {
            ...validBody,
            delegations: [
              {
                ...bodyDelegation,
                admins: ['   ', ' OCP-Admin@ocp.msf.org '],
                jurisdiction: [
                  { scope: 'domain', targets: [' OCP.msf.org ', '   '] },
                ],
              },
            ],
          },
          { 'if-match': '"etag-1"' },
        ),
      );
      expect(response.status).toBe(200);
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.delegations[0].admins).toEqual(['ocp-admin@ocp.msf.org']);
      expect(written.delegations[0].jurisdiction).toEqual([
        { scope: 'domain', targets: ['ocp.msf.org'] },
      ]);
      expect(LimitsPolicySchema.safeParse(written).success).toBe(true);
    });

    it('rejects duplicate delegation ids', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          delegations: [bodyDelegation, { ...bodyDelegation }],
        }),
      );
      expect(response.status).toBe(400);
    });

    it('rejects an override whose delegationId is not in the same body', async () => {
      const response = await PUT(
        putRequest({
          ...validBody,
          delegations: [],
          overrides: [
            {
              id: 'lim-000000000001',
              scope: 'user',
              targets: ['a@ocp.msf.org'],
              entries: [],
              delegationId: DEL_OCP,
            },
          ],
        }),
      );
      expect(response.status).toBe(400);
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('refuses to delete a delegation that still owns overrides, with the count', async () => {
      vi.mocked(readPolicy).mockResolvedValue(
        stored({
          delegations: [storedDelegation()],
          overrides: [
            storedOverride('lim-000000000001', { delegationId: DEL_OCP }),
            storedOverride('lim-000000000002', { delegationId: DEL_OCP }),
          ],
        }),
      );
      const response = await PUT(
        putRequest(
          {
            ...validBody,
            delegations: [],
            overrides: [
              {
                id: 'lim-000000000001',
                scope: 'user',
                targets: ['a@ocp.msf.org'],
                entries: [],
                delegationId: DEL_OCP,
              },
              {
                id: 'lim-000000000002',
                scope: 'user',
                targets: ['a@ocp.msf.org'],
                entries: [],
                delegationId: DEL_OCP,
              },
            ],
          },
          { 'if-match': '"etag-1"' },
        ),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(400);
      expect(body.details).toContain('2 override(s)');
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('allows deleting a delegation together with its overrides', async () => {
      vi.mocked(readPolicy).mockResolvedValue(
        stored({
          delegations: [storedDelegation()],
          overrides: [
            storedOverride('lim-000000000001', { delegationId: DEL_OCP }),
          ],
        }),
      );
      const response = await PUT(
        putRequest(
          { ...validBody, delegations: [], overrides: [] },
          { 'if-match': '"etag-1"' },
        ),
      );
      expect(response.status).toBe(200);
    });

    it('normalizes priority 0 and ceiling false on a delegationId override (design §3b/§3c)', async () => {
      await PUT(
        putRequest({
          ...validBody,
          delegations: [bodyDelegation],
          overrides: [
            {
              id: 'lim-000000000001',
              scope: 'user',
              targets: ['a@ocp.msf.org'],
              priority: 50,
              delegationId: DEL_OCP,
              entries: [
                { limitKey: 'chat.messagesPerDay', value: 5, ceiling: true },
              ],
            },
            {
              id: 'lim-000000000002',
              scope: 'user',
              targets: ['b@ocp.msf.org'],
              priority: 50,
              entries: [
                { limitKey: 'chat.messagesPerDay', value: 5, ceiling: true },
              ],
            },
          ],
        }),
      );
      const written = vi.mocked(writePolicy).mock.calls[0][1];
      expect(written.overrides[0].priority).toBe(0);
      expect(written.overrides[0].entries[0].ceiling).toBe(false);
      // A global-tier record keeps both levers.
      expect(written.overrides[1].priority).toBe(50);
      expect(written.overrides[1].entries[0].ceiling).toBe(true);
    });

    it('400s LIMITS_BUDGET_EXCEEDED when global overrides + Σ maxOverrides exceed the document cap', async () => {
      const globals = Array.from({ length: 101 }, (_, i) => ({
        id: `lim-${i.toString(16).padStart(12, '0')}`,
        scope: 'user',
        targets: [`u${i}@example.org`],
        entries: [],
      }));
      const response = await PUT(
        putRequest({
          ...validBody,
          overrides: globals,
          delegations: [{ ...bodyDelegation, maxOverrides: 100 }],
        }),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(400);
      expect(body.code).toBe('LIMITS_BUDGET_EXCEEDED');
      expect(writePolicy).not.toHaveBeenCalled();
    });

    it('writes the delegations and keeps the response shape { policy, etag }', async () => {
      const response = await PUT(
        putRequest({ ...validBody, delegations: [bodyDelegation] }),
      );
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.etag).toBe('"etag-new"');
      expect(body.data.policy.delegations[0]).toMatchObject({
        id: DEL_OCP,
        admins: ['ocp-admin@ocp.msf.org'],
      });
    });
  });
});
