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
 *
 * The last block pins the QUALIFIED rows (docs/LIMITS_COST_INSIGHTS_DESIGN.md
 * §4b): the preview resolves every perModel key once per model id / series
 * the policy mentions for the previewed principal — defaults, matching
 * overrides, scoped overrides inside an ACTIVE delegation only — AND, with
 * `usage=1`, once per model id / series the subject's counters name, since
 * enforcement meters every model under an UNQUALIFIED cap too (resolver.ts
 * resolveModelCells never evaluates a bare model cell). Same provenance as
 * unqualified rows, no duplicates, so every `model:<id>.requests` /
 * `family:<series>.requests` counter has a row to attach to. The own-limits
 * path stays unqualified.
 */
import { NextRequest } from 'next/server';

import { LimitsService } from '@/lib/services/limits/LimitsService';
import { counterCellName } from '@/lib/services/limits/resolver';
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

  describe('qualified rows (cost insights §4b)', () => {
    const DEL_QUAL = 'del-0000000000cc';
    const qualifiedPolicy: LimitsPolicy = LimitsPolicySchema.parse({
      ...policy,
      defaults: [
        ...policy.defaults,
        // Mentioned twice with different casing → ONE qualifier.
        { limitKey: 'model.requests', modelId: 'gpt-5.2', value: 200 },
        { limitKey: 'model.allowed', modelId: 'GPT-5.2', value: true },
      ],
      delegations: [
        ...policy.delegations,
        delegation(DEL_QUAL, {
          admins: ['other-admin@elsewhere.org'],
          jurisdiction: [{ scope: 'domain', targets: ['elsewhere.org'] }],
        }),
      ],
      overrides: [
        ...policy.overrides,
        // Global-tier domain rule: a family envelope for all of OCP.
        override('lim-0000000000a1', {
          label: 'OCP gpt envelope',
          scope: 'domain',
          targets: ['ocp.msf.org'],
          entries: [{ limitKey: 'model.requests', series: 'gpt', value: 500 }],
        }),
        // Scoped record inside a delegation alice IS in.
        override('lim-0000000000a2', {
          scope: 'user',
          targets: ['alice@ocp.msf.org'],
          delegationId: DEL_OCP,
          entries: [
            {
              limitKey: 'model.requests',
              modelId: 'claude-sonnet-4-6',
              value: 50,
            },
          ],
        }),
        // Scoped record whose targets name alice but whose delegation does
        // NOT contain her: inert by containment — must produce no row.
        override('lim-0000000000a3', {
          scope: 'user',
          targets: ['alice@ocp.msf.org'],
          delegationId: DEL_QUAL,
          entries: [{ limitKey: 'model.allowed', modelId: 'o3', value: false }],
        }),
        // Applies to somebody else entirely.
        override('lim-0000000000a4', {
          scope: 'user',
          targets: ['bob@ocp.msf.org'],
          entries: [
            { limitKey: 'model.requests', modelId: 'gpt-5-nano', value: 10 },
          ],
        }),
        // Disabled: silent.
        override('lim-0000000000a5', {
          enabled: false,
          scope: 'domain',
          targets: ['ocp.msf.org'],
          entries: [
            { limitKey: 'model.requests', modelId: 'gpt-4.1', value: 10 },
          ],
        }),
      ],
    });

    type Row = {
      limitKey: string;
      modelId?: string;
      series?: string;
      [k: string]: unknown;
    };
    const rowsOf = (body: { data: { limits: Row[] } }) => body.data.limits;
    const qualified = (rows: Row[]) =>
      rows.filter((r) => r.modelId !== undefined || r.series !== undefined);
    const find = (rows: Row[], key: string, q: Partial<Row>) =>
      rows.find(
        (r) =>
          r.limitKey === key &&
          r.modelId === q.modelId &&
          r.series === q.series,
      );

    beforeEach(() => {
      snapshot.policy = qualifiedPolicy;
      stored.policy = qualifiedPolicy;
    });

    it('appends one row per perModel key × mentioned qualifier, with the same provenance as unqualified rows', async () => {
      const body = await parseJsonResponse(
        await GET(request('as=alice@ocp.msf.org')),
      );
      const rows = rowsOf(body);

      expect(
        find(rows, 'model.requests', { modelId: 'gpt-5.2' }),
      ).toMatchObject({
        value: 200,
        source: 'global',
        tier: 'global',
        window: 'day',
      });
      expect(find(rows, 'model.requests', { series: 'gpt' })).toMatchObject({
        value: 500,
        source: 'domain',
        tier: 'global',
        overrideId: 'lim-0000000000a1',
      });
      expect(
        find(rows, 'model.requests', { modelId: 'claude-sonnet-4-6' }),
      ).toMatchObject({
        value: 50,
        source: 'user',
        tier: 'scoped',
        overrideId: 'lim-0000000000a2',
      });
      // Every perModel key is resolved for every qualifier, so the client
      // has the full conjunctive cell set per model (allowed + requests).
      expect(find(rows, 'model.allowed', { modelId: 'gpt-5.2' })).toMatchObject(
        { value: true },
      );
      expect(
        find(rows, 'model.allowed', { modelId: 'claude-sonnet-4-6' }),
      ).toMatchObject({ value: true, source: 'catalog' });
      expect(find(rows, 'model.allowed', { series: 'gpt' })).toMatchObject({
        value: true,
      });
      // The unqualified rows are still there — to DISPLAY the unqualified
      // default. Enforcement never evaluates a bare model cell: an
      // unqualified entry is only the lowest-specificity candidate inside
      // each model / family cell (resolver.ts resolveModelCells).
      expect(find(rows, 'model.requests', {})).toMatchObject({ value: null });
      expect(find(rows, 'model.allowed', {})).toMatchObject({ value: true });
    });

    it('mentions only what applies to the principal: no rows for another user, a disabled record, or a scoped record outside an active delegation', async () => {
      const rows = rowsOf(
        await parseJsonResponse(await GET(request('as=alice@ocp.msf.org'))),
      );
      const ids = new Set(qualified(rows).map((r) => r.modelId ?? r.series));
      expect(ids).toEqual(new Set(['gpt-5.2', 'gpt', 'claude-sonnet-4-6']));
      expect(ids.has('gpt-5-nano')).toBe(false);
      expect(ids.has('gpt-4.1')).toBe(false);
      expect(ids.has('o3')).toBe(false);
      // And the inert scoped record never leaks through provenance either.
      expect(JSON.stringify(rows)).not.toContain('lim-0000000000a3');
    });

    it('never emits duplicate cells (case-different mentions collapse to one qualifier)', async () => {
      const rows = rowsOf(
        await parseJsonResponse(await GET(request('as=alice@ocp.msf.org'))),
      );
      const cells = rows.map(
        (r) =>
          `${r.limitKey}|${r.modelId?.toLowerCase() ?? ''}|${r.series?.toLowerCase() ?? ''}`,
      );
      expect(new Set(cells).size).toBe(cells.length);
      expect(
        rows.filter(
          (r) =>
            r.limitKey === 'model.allowed' &&
            r.modelId?.toLowerCase() === 'gpt-5.2',
        ),
      ).toHaveLength(1);
    });

    it('gives every model:<id>.requests usage counter of a MENTIONED qualifier a row to attach to', async () => {
      vi.mocked(lookupUsage).mockResolvedValue({
        usageUnavailable: false,
        subjectId: 'oid-alice',
        usage: {
          'chat.messagesPerDay': { used: 7, window: 'day' },
          'model:gpt-5.2.requests': { used: 3, window: 'day' },
          'family:gpt.requests': { used: 9, window: 'day' },
        },
      });
      const body = await parseJsonResponse(
        await GET(request('as=alice@ocp.msf.org&usage=1')),
      );
      const rows = rowsOf(body);
      for (const cell of Object.keys(body.data.usage)) {
        const row = rows.find((r) => counterCellName(r) === cell);
        expect(row, cell).toBeDefined();
      }
      expect(
        counterCellName(find(rows, 'model.requests', { modelId: 'gpt-5.2' })!),
      ).toBe('model:gpt-5.2.requests');
    });

    describe('counters written under an UNQUALIFIED cap (nothing mentioned)', () => {
      // The simplest per-model policy: "every model 100/day". Enforcement
      // resolves the model cell and the family cell (resolver.ts
      // resolveModelCells) — the unqualified entry wins each as its only
      // candidate — and writes `model:o3.requests` / `family:o-series.requests`,
      // never `model.requests`. The preview must give both counters a row.
      const unqualifiedPolicy: LimitsPolicy = LimitsPolicySchema.parse({
        ...policy,
        defaults: [
          ...policy.defaults,
          { limitKey: 'model.requests', value: 100 },
        ],
      });
      const counters = {
        'chat.messagesPerDay': { used: 7, window: 'day' as const },
        'model:o3.requests': { used: 5, window: 'day' as const },
        'family:o-series.requests': { used: 5, window: 'day' as const },
      };

      beforeEach(() => {
        snapshot.policy = unqualifiedPolicy;
        stored.policy = unqualifiedPolicy;
        vi.mocked(lookupUsage).mockResolvedValue({
          usageUnavailable: false,
          subjectId: 'oid-alice',
          usage: counters,
        });
      });

      it('resolves a row for every per-model counter in the usage, carrying the cap enforcement applied', async () => {
        const body = await parseJsonResponse(
          await GET(request('as=alice@ocp.msf.org&usage=1')),
        );
        const rows = rowsOf(body);
        for (const cell of Object.keys(body.data.usage)) {
          expect(
            rows.find((r) => counterCellName(r) === cell),
            cell,
          ).toBeDefined();
        }
        // Each metered cell resolves as enforcement resolved it: the
        // unqualified default is the winning candidate, so the row is its
        // value with its provenance — not a copy of the bare row's identity.
        expect(find(rows, 'model.requests', { modelId: 'o3' })).toMatchObject({
          value: 100,
          source: 'global',
          tier: 'global',
        });
        expect(
          find(rows, 'model.requests', { series: 'o-series' }),
        ).toMatchObject({ value: 100, source: 'global', tier: 'global' });
        // The full conjunctive cell set per qualifier, as for mentions.
        expect(find(rows, 'model.allowed', { modelId: 'o3' })).toMatchObject({
          value: true,
        });
        // The bare row is still listed, for the unqualified default itself.
        expect(find(rows, 'model.requests', {})).toMatchObject({
          value: 100,
        });
      });

      it('a qualified entry shadows the unqualified default on its own cell, exactly as enforcement resolves it', async () => {
        const shadowing: LimitsPolicy = LimitsPolicySchema.parse({
          ...unqualifiedPolicy,
          defaults: [
            ...unqualifiedPolicy.defaults,
            { limitKey: 'model.requests', modelId: 'o3', value: 20 },
          ],
        });
        snapshot.policy = shadowing;
        const rows = rowsOf(
          await parseJsonResponse(
            await GET(request('as=alice@ocp.msf.org&usage=1')),
          ),
        );
        expect(find(rows, 'model.requests', { modelId: 'o3' })).toMatchObject({
          value: 20,
        });
        // The family cell is a SEPARATE conjunctive cell: the model entry
        // does not speak to it, so the unqualified default still governs.
        expect(
          find(rows, 'model.requests', { series: 'o-series' }),
        ).toMatchObject({ value: 100 });
      });

      it('derives qualifiers from usage only when usage was asked for (and fetched)', async () => {
        const plain = rowsOf(
          await parseJsonResponse(await GET(request('as=alice@ocp.msf.org'))),
        );
        expect(qualified(plain)).toEqual([]);

        vi.mocked(lookupUsage).mockResolvedValue({
          usageUnavailable: true,
          reason: 'graph_error',
        });
        const unavailable = rowsOf(
          await parseJsonResponse(
            await GET(request('as=alice@ocp.msf.org&usage=1')),
          ),
        );
        expect(qualified(unavailable)).toEqual([]);
      });

      it('dedupes a counter against a policy mention case-insensitively, keeping the mention’s spelling', async () => {
        const mentioning: LimitsPolicy = LimitsPolicySchema.parse({
          ...unqualifiedPolicy,
          defaults: [
            ...unqualifiedPolicy.defaults,
            { limitKey: 'model.allowed', modelId: 'O3', value: true },
          ],
        });
        snapshot.policy = mentioning;
        const rows = rowsOf(
          await parseJsonResponse(
            await GET(request('as=alice@ocp.msf.org&usage=1')),
          ),
        );
        const o3Rows = rows.filter(
          (r) =>
            r.limitKey === 'model.requests' &&
            r.modelId?.toLowerCase() === 'o3',
        );
        expect(o3Rows).toHaveLength(1);
        expect(o3Rows[0].modelId).toBe('O3');
        // Still attaches: counterCellName lower-cases the qualifier.
        expect(counterCellName(o3Rows[0])).toBe('model:o3.requests');
        const cells = rows.map(
          (r) =>
            `${r.limitKey}|${r.modelId?.toLowerCase() ?? ''}|${r.series?.toLowerCase() ?? ''}`,
        );
        expect(new Set(cells).size).toBe(cells.length);
      });

      it('ignores usage keys that are not per-model counters or fail the dimension check', async () => {
        vi.mocked(lookupUsage).mockResolvedValue({
          usageUnavailable: false,
          subjectId: 'oid-alice',
          usage: {
            ...counters,
            'chat.tokensPerDay': { used: 10, window: 'day' },
            'feature.webSearch.callsPerDay': { used: 1, window: 'day' },
            // Not a perModel suffix (no such counter is ever written).
            'model:o3.tokens': { used: 1, window: 'day' },
            // Would never pass resolveModelCells' dimension check.
            'model:not a dimension!.requests': { used: 1, window: 'day' },
            'family:.requests': { used: 1, window: 'day' },
          },
        });
        const rows = rowsOf(
          await parseJsonResponse(
            await GET(request('as=alice@ocp.msf.org&usage=1')),
          ),
        );
        expect(
          new Set(qualified(rows).map((r) => r.modelId ?? r.series)),
        ).toEqual(new Set(['o3', 'o-series']));
      });
    });

    it('a SCOPED preview carries the same qualified rows, with the ceiling explanation intact', async () => {
      mockAuth.mockResolvedValue(session('ocp-admin@ocp.msf.org'));
      const response = await GET(request('as=alice@ocp.msf.org'));
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.scopedPreview).toBe(true);
      const rows = rowsOf(body);
      expect(
        find(rows, 'model.requests', { modelId: 'claude-sonnet-4-6' }),
      ).toMatchObject({ value: 50, tier: 'scoped' });
      expect(find(rows, 'model.requests', { series: 'gpt' })).toMatchObject({
        value: 500,
      });
      expect(limitFor(body, 'chat.messagesPerDay')).toMatchObject({
        value: 60,
        ceilingLabel: 'OCP cap',
      });
    });

    it('a principal the policy mentions nothing for gets no qualified rows (only the global default ones)', async () => {
      const rows = rowsOf(
        await parseJsonResponse(await GET(request('as=x@y.org'))),
      );
      expect(
        new Set(qualified(rows).map((r) => r.modelId ?? r.series)),
      ).toEqual(new Set(['gpt-5.2']));
    });

    it('the caller’s OWN limits stay unqualified', async () => {
      mockAuth.mockResolvedValue(session('alice@ocp.msf.org'));
      const rows = rowsOf(await parseJsonResponse(await GET(request(''))));
      expect(qualified(rows)).toEqual([]);
      // … even though a per-model cap on her exists.
      expect(rows.some((r) => r.limitKey === 'model.requests')).toBe(false);
    });
  });
});
