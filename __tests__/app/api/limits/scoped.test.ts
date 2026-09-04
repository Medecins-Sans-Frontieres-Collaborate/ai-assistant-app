/**
 * GET /api/limits/scoped — the scoped admin's view (design §5, §6b, §8).
 *
 * Pins the information boundary (only the caller's delegations, their
 * `admins` omitted, only their overrides; never defaults or an ETag), the
 * server-computed verdicts/flags, read-only visibility of a disabled
 * delegation, and the failure posture: a read failure is "unavailable", never
 * a 403 that would read as revocation.
 */
import {
  createLimitsBlobStorage,
  readPolicy,
} from '@/lib/services/limits/limitsStore';
import {
  LimitDelegation,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/limits/scoped/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/limits/limitsStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/limits/limitsStore')>();
  return {
    ...actual,
    createLimitsBlobStorage: vi.fn(),
    readPolicy: vi.fn(),
  };
});

const DEL_OCP = 'del-0000000000aa';
const DEL_PARIS = 'del-0000000000bb';
const DEL_OFF = 'del-0000000000cc';
const GROUP_A = '00000000-0000-0000-0000-00000000000a';

const STAMP = {
  createdBy: 'global@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'global@example.com',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function delegation(
  id: string,
  extra: Partial<LimitDelegation> = {},
): LimitDelegation {
  return {
    id,
    label: id,
    enabled: true,
    admins: [],
    jurisdiction: [],
    maxOverrides: 25,
    ...STAMP,
    ...extra,
  };
}

function override(
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
    entries: [{ limitKey: 'chat.messagesPerDay', value: 5, ceiling: false }],
    ...STAMP,
    ...extra,
  };
}

function policyWith(input: Partial<LimitsPolicy>): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: [{ limitKey: 'chat.messagesPerDay', value: 100 }],
    mode: 'enforce',
    timezone: 'Europe/Paris',
    updatedBy: 'global@example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  });
}

const fullPolicy = policyWith({
  delegations: [
    delegation(DEL_OCP, {
      admins: ['OCP-Admin@ocp.msf.org'],
      jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    }),
    delegation(DEL_PARIS, {
      admins: ['paris@paris.msf.org'],
      jurisdiction: [{ scope: 'group', targets: [GROUP_A] }],
    }),
    delegation(DEL_OFF, {
      enabled: false,
      admins: ['ocp-admin@ocp.msf.org'],
      jurisdiction: [{ scope: 'domain', targets: ['ocb.msf.org'] }],
    }),
  ],
  overrides: [
    override('lim-000000000001', { delegationId: DEL_OCP }),
    // Narrowed: the delegation is now domain-anchored on ocp only.
    override('lim-000000000002', {
      delegationId: DEL_OCP,
      targets: ['b@ocp.msf.org', 'stranger@elsewhere.org'],
    }),
    override('lim-000000000003', { delegationId: DEL_PARIS }),
    override('lim-000000000004', {
      delegationId: DEL_OFF,
      targets: ['c@ocb.msf.org'],
    }),
    override('lim-000000000005', { label: 'global secret rule' }),
  ],
});

const session = (mail: string, viewAs?: unknown) => ({
  user: { id: 'oid-x', displayName: 'X', mail, viewAs },
});

describe('GET /api/limits/scoped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    vi.mocked(createLimitsBlobStorage).mockReturnValue({} as never);
    vi.mocked(readPolicy).mockResolvedValue({
      policy: fullPolicy,
      etag: '"e1"',
    });
  });

  it('401s without a session and 403s without a mail', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mockAuth.mockResolvedValue({ user: { id: 'oid-1', displayName: 'X' } });
    expect((await GET()).status).toBe(403);
  });

  it('403s a signed-in user named in no delegation', async () => {
    mockAuth.mockResolvedValue(session('nobody@ocp.msf.org'));
    expect((await GET()).status).toBe(403);
    expect(readPolicy).toHaveBeenCalledTimes(1);
  });

  it('returns ONLY the caller’s delegations (admins omitted) and their overrides, with verdicts and flags', async () => {
    mockAuth.mockResolvedValue(session('ocp-admin@ocp.msf.org'));
    const response = await GET();
    const body = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      isGlobalAdmin: false,
      mode: 'enforce',
      timezone: 'Europe/Paris',
      policyUnavailable: false,
    });
    // Nothing that belongs to the whole policy or to other admins.
    expect(body.data).not.toHaveProperty('defaults');
    expect(body.data).not.toHaveProperty('etag');
    expect(body.data.delegations.map((d: { id: string }) => d.id)).toEqual([
      DEL_OCP,
      DEL_OFF,
    ]);
    for (const d of body.data.delegations) {
      expect(d).not.toHaveProperty('admins');
    }
    expect(body.data.delegations[0]).toMatchObject({
      overrideCount: 2,
      maxOverrides: 25,
      warnings: [],
    });
    expect(body.data.delegations[1]).toMatchObject({
      enabled: false,
      overrideCount: 1,
    });

    const ids = body.data.overrides.map((o: { id: string }) => o.id);
    expect(ids).toEqual([
      'lim-000000000001',
      'lim-000000000002',
      'lim-000000000004',
    ]);
    expect(JSON.stringify(body.data)).not.toContain('global secret rule');

    const narrowed = body.data.overrides[1];
    expect(narrowed.flags).toEqual(['out-of-scope-targets']);
    expect(narrowed.verdicts).toEqual([
      { target: 'b@ocp.msf.org', status: 'in-scope', reason: 'domain-match' },
      {
        target: 'stranger@elsewhere.org',
        status: 'out-of-scope',
        reason: 'not-in-domains',
      },
    ]);
    // Disabled delegation stays visible to its author (§6b), flagged inert.
    expect(body.data.overrides[2].flags).toEqual(['delegation-disabled']);
  });

  it('warns on a delegation with no domain/user anchor (§8)', async () => {
    mockAuth.mockResolvedValue(session('paris@paris.msf.org'));
    const body = await parseJsonResponse(await GET());
    expect(body.data.delegations).toHaveLength(1);
    expect(body.data.delegations[0].warnings).toEqual([
      'no-domain-or-user-anchor',
    ]);
    expect(body.data.overrides.map((o: { id: string }) => o.id)).toEqual([
      'lim-000000000003',
    ]);
  });

  it('gives a global admin named in no delegation an empty view rather than a 403', async () => {
    mockAuth.mockResolvedValue(session('global@example.com'));
    const response = await GET();
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      isGlobalAdmin: true,
      delegations: [],
      overrides: [],
    });
  });

  it('shows a view-as-demoted global admin exactly the delegations in the cookie, never those naming their real mail', async () => {
    const withCookie = policyWith({
      ...fullPolicy,
      delegations: fullPolicy.delegations.map((d) =>
        d.id === DEL_PARIS ? { ...d, admins: ['global@example.com'] } : d,
      ),
    });
    vi.mocked(readPolicy).mockResolvedValue({
      policy: withCookie,
      etag: '"e"',
    });
    mockAuth.mockResolvedValue(
      session('global@example.com', {
        overrides: { adminRole: 'local', limitDelegationIds: [DEL_OCP] },
      }),
    );
    const body = await parseJsonResponse(await GET());
    expect(body.data.isGlobalAdmin).toBe(false);
    expect(body.data.delegations.map((d: { id: string }) => d.id)).toEqual([
      DEL_OCP,
    ]);
  });

  it('403s when no policy has been authored (no delegation can exist) unless global', async () => {
    vi.mocked(readPolicy).mockResolvedValue(null);
    mockAuth.mockResolvedValue(session('ocp-admin@ocp.msf.org'));
    expect((await GET()).status).toBe(403);
    mockAuth.mockResolvedValue(session('global@example.com'));
    const body = await parseJsonResponse(await GET());
    expect(body.data).toMatchObject({
      isGlobalAdmin: true,
      policyUnavailable: false,
      delegations: [],
    });
  });

  it('answers policyUnavailable on a read failure — never 403, never an empty "nothing configured"', async () => {
    vi.mocked(readPolicy).mockRejectedValue(new Error('storage down'));
    mockAuth.mockResolvedValue(session('ocp-admin@ocp.msf.org'));
    const response = await GET();
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.data.policyUnavailable).toBe(true);
    expect(body.data.delegations).toEqual([]);
    expect(body.data.overrides).toEqual([]);
  });
});
