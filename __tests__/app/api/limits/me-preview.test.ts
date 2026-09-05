/**
 * /api/limits/me?as= — the effective-limits preview after scoped admins
 * (design §6c): who may preview whom, the tier/ceiling provenance — which
 * is PREVIEW-ONLY: the own-limits path never carries the tier or the pinning
 * record's id/label — the unavailable-is-not-forbidden posture, and opt-in
 * usage.
 *
 * Two policy sources are mocked on purpose: the `LimitsService` snapshot
 * (what global admins and the caller's own limits resolve against) and the
 * direct `readPolicy` storage read the SCOPED preview gate uses so a fresh
 * delegation or override is never refused or ignored for a snapshot TTL.
 */
import { NextRequest } from 'next/server';

import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  LimitDelegation,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';
import { lookupUsage } from '@/lib/services/limits/usageLookup';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/limits/me/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));
const snapshot = vi.hoisted(() => ({
  policy: null as unknown,
  policyUnavailable: false,
}));
const stored = vi.hoisted(() => ({
  policy: null as unknown,
  fail: false,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/limits/LimitsService', () => ({
  LimitsService: {
    getInstance: () => ({
      ensureFresh: vi.fn(),
      getSnapshot: () => ({ ...snapshot, etag: null, fetchedAt: 1 }),
    }),
  },
}));
vi.mock('@/lib/services/limits/limitsStore', () => ({
  createLimitsBlobStorage: vi.fn(() => ({})),
  readPolicy: vi.fn(async () => {
    if (stored.fail) throw new Error('blob down');
    return stored.policy === null
      ? null
      : { policy: stored.policy, etag: '"e1"' };
  }),
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(async () => []),
  getCachedGroupIdsForUser: vi.fn(() => []),
  isGroupMembershipDegradedForUser: vi.fn(() => false),
}));
vi.mock('@/lib/services/limits/usageLookup', () => ({
  lookupUsage: vi.fn(),
}));

const DEL_OCP = 'del-0000000000aa';
const DEL_GROUPS = 'del-0000000000bb';
const STAMP = {
  createdBy: 'global@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'global@example.com',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function delegation(
  id: string,
  extra: Partial<LimitDelegation>,
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

function override(id: string, extra: Partial<LimitOverride>): LimitOverride {
  return {
    id,
    label: '',
    enabled: true,
    scope: 'user',
    targets: [],
    priority: 0,
    entries: [],
    ...STAMP,
    ...extra,
  };
}

const policy: LimitsPolicy = LimitsPolicySchema.parse({
  version: 1,
  defaults: [{ limitKey: 'chat.messagesPerDay', value: 100 }],
  timezone: 'Europe/Paris',
  delegations: [
    delegation(DEL_OCP, {
      admins: ['ocp-admin@ocp.msf.org'],
      jurisdiction: [
        { scope: 'domain', targets: ['ocp.msf.org'] },
        { scope: 'user', targets: ['friend@elsewhere.org'] },
      ],
    }),
    delegation(DEL_GROUPS, {
      admins: ['groups-admin@paris.msf.org'],
      jurisdiction: [{ scope: 'group', targets: ['g-1'] }],
    }),
  ],
  overrides: [
    // Global-tier domain ceiling: OCP is pinned at 60.
    override('lim-0000000000c1', {
      label: 'OCP cap',
      scope: 'domain',
      targets: ['ocp.msf.org'],
      entries: [{ limitKey: 'chat.messagesPerDay', value: 60, ceiling: true }],
    }),
    // Scoped user override tries to lift alice to 500.
    override('lim-0000000000e1', {
      label: 'alice lift (scoped, secret-ish label)',
      scope: 'user',
      targets: ['alice@ocp.msf.org'],
      delegationId: DEL_OCP,
      entries: [{ limitKey: 'chat.messagesPerDay', value: 500 }],
    }),
    // Global user override with another label — must NOT leak as ceilingLabel.
    override('lim-0000000000f1', {
      label: 'unrelated global rule',
      scope: 'user',
      targets: ['alice@ocp.msf.org'],
      entries: [{ limitKey: 'chat.tokensPerDay', value: 1000 }],
    }),
  ],
  updatedBy: 'global@example.com',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const session = (mail: string) => ({
  user: { id: 'oid-caller', displayName: 'Caller', mail },
});

function request(query: string) {
  return new NextRequest(`http://localhost/api/limits/me?${query}`);
}

function limitFor(
  body: { data: { limits: { limitKey: string }[] } },
  key: string,
) {
  return body.data.limits.find((l) => l.limitKey === key) as
    | Record<string, unknown>
    | undefined;
}

describe('GET /api/limits/me?as=', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    snapshot.policy = policy;
    snapshot.policyUnavailable = false;
    stored.policy = policy;
    stored.fail = false;
    mockAuth.mockResolvedValue(session('global@example.com'));
    vi.mocked(lookupUsage).mockResolvedValue({
      usageUnavailable: false,
      subjectId: 'oid-alice',
      usage: { 'chat.messagesPerDay': { used: 7, window: 'day' } },
    });
    // Sanity: the mocked service is what the route sees.
    expect(LimitsService.getInstance().getSnapshot().policy).toBe(policy);
  });

  it('400s a non-mail `as`', async () => {
    expect((await GET(request('as=not-a-mail'))).status).toBe(400);
  });

  describe('global admin', () => {
    it('previews anyone with tier and the pinning ceiling record (id + ONLY its label)', async () => {
      const response = await GET(request('as=Alice@OCP.msf.org'));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.preview).toBe(true);
      expect(body.data.scopedPreview).toBeUndefined();
      expect(body.data.subject).toBe('alice@ocp.msf.org');

      const messages = limitFor(body, 'chat.messagesPerDay');
      expect(messages).toMatchObject({
        value: 60,
        source: 'user',
        tier: 'scoped',
        overrideId: 'lim-0000000000e1',
        ceilingApplied: true,
        ceilingOverrideId: 'lim-0000000000c1',
        ceilingLabel: 'OCP cap',
      });
      const tokens = limitFor(body, 'chat.tokensPerDay');
      expect(tokens).toMatchObject({
        value: 1000,
        tier: 'global',
        overrideId: 'lim-0000000000f1',
      });
      expect(tokens).not.toHaveProperty('ceilingLabel');
      // No override label other than the pinning record's reaches the client.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('unrelated global rule');
      expect(serialized).not.toContain('secret-ish');
    });

    it('still previews while the policy is unavailable (resolves from the catalog)', async () => {
      snapshot.policy = null;
      snapshot.policyUnavailable = true;
      const response = await GET(request('as=x@y.org'));
      expect(response.status).toBe(200);
      expect((await parseJsonResponse(response)).data.policyUnavailable).toBe(
        true,
      );
    });

    it('attaches usage only when asked, and flags unavailability instead of failing', async () => {
      const plain = await parseJsonResponse(
        await GET(request('as=alice@ocp.msf.org')),
      );
      expect(plain.data).not.toHaveProperty('usage');
      expect(lookupUsage).not.toHaveBeenCalled();

      const withUsage = await parseJsonResponse(
        await GET(request('as=alice@ocp.msf.org&usage=1')),
      );
      expect(withUsage.data.usage).toEqual({
        'chat.messagesPerDay': { used: 7, window: 'day' },
      });
      expect(lookupUsage).toHaveBeenCalledWith(
        expect.anything(),
        'alice@ocp.msf.org',
        { timezone: 'Europe/Paris' },
      );

      vi.mocked(lookupUsage).mockResolvedValue({
        usageUnavailable: true,
        reason: 'consent_missing',
      });
      const unavailable = await GET(request('as=alice@ocp.msf.org&usage=1'));
      const body = await parseJsonResponse(unavailable);
      expect(unavailable.status).toBe(200);
      expect(body.data.usageUnavailable).toBe(true);
      expect(body.data).not.toHaveProperty('usage');
    });
  });

  describe('scoped admin', () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue(session('ocp-admin@ocp.msf.org'));
    });

    it('may preview a mail in a delegation domain, marked scopedPreview, with the ceiling explanation', async () => {
      const response = await GET(request('as=alice@ocp.msf.org'));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.scopedPreview).toBe(true);
      expect(limitFor(body, 'chat.messagesPerDay')).toMatchObject({
        value: 60,
        ceilingOverrideId: 'lim-0000000000c1',
        ceilingLabel: 'OCP cap',
      });
    });

    it('may preview a listed jurisdiction user', async () => {
      expect((await GET(request('as=friend@elsewhere.org'))).status).toBe(200);
    });

    it('403s LIMITS_PREVIEW_OUT_OF_SCOPE for a mail outside the jurisdiction', async () => {
      const response = await GET(request('as=eve@elsewhere.org'));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(403);
      expect(body.code).toBe('LIMITS_PREVIEW_OUT_OF_SCOPE');
      expect(body.details).toBe('outside');
      expect(lookupUsage).not.toHaveBeenCalled();
    });

    it('403s LIMITS_PREVIEW_OUT_OF_SCOPE (undecidable) for a group-only jurisdiction', async () => {
      mockAuth.mockResolvedValue(session('groups-admin@paris.msf.org'));
      const response = await GET(request('as=anyone@ocp.msf.org'));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(403);
      expect(body.code).toBe('LIMITS_PREVIEW_OUT_OF_SCOPE');
      expect(body.details).toBe('undecidable');
    });

    it('503s LIMITS_POLICY_UNAVAILABLE when the policy cannot be read — never a 403', async () => {
      stored.fail = true;
      const response = await GET(request('as=alice@ocp.msf.org'));
      expect(response.status).toBe(503);
      expect((await parseJsonResponse(response)).code).toBe(
        'LIMITS_POLICY_UNAVAILABLE',
      );
    });

    it('gates and resolves against STORAGE, not the replica snapshot (a fresh delegation is never refused for a TTL)', async () => {
      // This replica's snapshot predates the delegation entirely …
      snapshot.policy = { ...policy, delegations: [], overrides: [] };
      const response = await GET(request('as=alice@ocp.msf.org'));
      const body = await parseJsonResponse(response);
      // … yet the preview is allowed and reflects the stored overrides.
      expect(response.status).toBe(200);
      expect(body.data.policyUnavailable).toBe(false);
      expect(limitFor(body, 'chat.messagesPerDay')).toMatchObject({
        value: 60,
        tier: 'scoped',
        ceilingOverrideId: 'lim-0000000000c1',
      });
    });

    it('a stale snapshot marked unavailable does not 503 a scoped preview when storage answers', async () => {
      snapshot.policy = null;
      snapshot.policyUnavailable = true;
      expect((await GET(request('as=alice@ocp.msf.org'))).status).toBe(200);
    });

    it('403s when no policy document exists (nobody can be a scoped admin yet)', async () => {
      stored.policy = null;
      const response = await GET(request('as=alice@ocp.msf.org'));
      expect(response.status).toBe(403);
      expect((await parseJsonResponse(response)).code).toBe('FORBIDDEN');
    });

    it('never previews under a disabled delegation', async () => {
      stored.policy = {
        ...policy,
        delegations: policy.delegations.map((d) =>
          d.id === DEL_OCP ? { ...d, enabled: false } : d,
        ),
      };
      expect((await GET(request('as=alice@ocp.msf.org'))).status).toBe(403);
    });
  });

  it('403s FORBIDDEN for a signed-in user who is neither global nor scoped', async () => {
    mockAuth.mockResolvedValue(session('user@ocp.msf.org'));
    const response = await GET(request('as=alice@ocp.msf.org'));
    expect(response.status).toBe(403);
    expect((await parseJsonResponse(response)).code).toBe('FORBIDDEN');
  });

  it('the caller’s OWN limits carry no provenance: no tier, no pinning record id or label (design §6c scopes those to the preview)', async () => {
    mockAuth.mockResolvedValue(session('alice@ocp.msf.org'));
    const body = await parseJsonResponse(await GET(request('')));
    const messages = limitFor(body, 'chat.messagesPerDay');
    expect(messages).toMatchObject({
      value: 60,
      source: 'user',
      overrideId: 'lim-0000000000e1',
      ceilingApplied: true,
    });
    expect(messages).not.toHaveProperty('tier');
    expect(messages).not.toHaveProperty('ceilingOverrideId');
    expect(messages).not.toHaveProperty('ceilingLabel');
    // No admin-authored label reaches a plain user through their own limits.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('OCP cap');
    expect(serialized).not.toContain('lim-0000000000c1');
  });
});
