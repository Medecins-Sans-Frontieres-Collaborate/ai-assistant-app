/**
 * /api/limits/me — the OWN-LIMITS branch's two new params
 * (docs/LIMITS_USER_FACING_UX.md §7.1): `usage=1` reads the caller's own
 * counters straight from the ledgers by session oid (no Graph, no
 * lookupUsage, zero storage when nothing is numeric, `usageUnavailable` on
 * failure) and `models=` answers per catalog model with the conjunctive
 * resolution enforcement uses. The `?as=` preview must ignore both, and the
 * no-provenance promise must hold with them on.
 */
import { NextRequest } from 'next/server';

import { resetAt } from '@/lib/services/limits/periods';
import {
  LimitEntry,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';
import { readUsage } from '@/lib/services/limits/usageStore';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { parseJsonResponse } from '../helpers';

import { GET } from '@/app/api/limits/me/route';
import { LIMIT_DEFINITIONS } from '@/config/limits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));
const snapshot = vi.hoisted(() => ({
  policy: null as unknown,
  policyUnavailable: false,
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
  readPolicy: vi.fn(async () => null),
}));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(async () => []),
  getCachedGroupIdsForUser: vi.fn(() => []),
  isGroupMembershipDegradedForUser: vi.fn(() => false),
}));
vi.mock('@/lib/services/limits/usageLookup', () => ({
  lookupUsage: vi.fn(),
}));
vi.mock('@/lib/services/limits/usageStore', () => ({
  readUsage: vi.fn(async () => ({})),
}));

const TZ = 'Europe/Paris';

function policyWith(
  defaults: Array<Partial<LimitEntry> & Pick<LimitEntry, 'limitKey'>>,
  extra: Partial<LimitsPolicy> = {},
): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults,
    overrides: [],
    mode: 'enforce',
    timezone: TZ,
    updatedBy: 'global@example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

/**
 * The catalog ships a few counters with NUMERIC compiled defaults (the
 * flag-gated M365 tool budgets), so "nothing numeric" is only reachable when
 * a policy explicitly lifts them. Derived from the catalog so this fixture
 * cannot drift from it.
 */
const LIFT_COMPILED_COUNTERS: LimitEntry[] = LIMIT_DEFINITIONS.filter(
  (d) => d.kind === 'counter' && typeof d.defaultValue === 'number',
).map((d) => ({ limitKey: d.key, value: null, ceiling: false }));

function request(query: string) {
  return new NextRequest(`http://localhost/api/limits/me?${query}`);
}

async function get(query: string) {
  const response = await GET(request(query));
  expect(response.status).toBe(200);
  return (await parseJsonResponse(response)).data;
}

function limitFor(data: { limits: { limitKey: string }[] }, key: string) {
  return data.limits.find((l) => l.limitKey === key) as
    | Record<string, unknown>
    | undefined;
}

/** Counters keyed per ledger, as the mocked readUsage will answer them. */
function ledgers(
  day: Record<string, number>,
  month: Record<string, number> = {},
) {
  vi.mocked(readUsage).mockImplementation(async (_subject, kind) =>
    kind === 'day' ? day : kind === 'month' ? month : {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
  snapshot.policy = policyWith([]);
  snapshot.policyUnavailable = false;
  mockAuth.mockResolvedValue({
    user: { id: 'oid-caller', displayName: 'Caller', mail: 'alice@msf.org' },
  });
  vi.mocked(readUsage).mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/limits/me (own limits)', () => {
  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(request('usage=1'))).status).toBe(401);
  });

  it('warms the group cache before resolving, as the chat route does', async () => {
    await get('');
    expect(resolveUserGroupIds).toHaveBeenCalledTimes(1);
  });

  describe('usage=1', () => {
    it('is off by default: no counters attached, storage never touched', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
      ]);
      const data = await get('');
      expect(readUsage).not.toHaveBeenCalled();
      const row = limitFor(data, 'chat.messagesPerDay');
      expect(row).toMatchObject({ value: 100 });
      expect(row).not.toHaveProperty('used');
      expect(row).not.toHaveProperty('remaining');
      expect(row).not.toHaveProperty('resetAt');
      expect(data).not.toHaveProperty('usageUnavailable');
    });

    it('takes the ZERO-STORAGE path when nothing numeric constrains the caller', async () => {
      // Gates and ceilings are not counters; unlimited counters have nothing
      // to count. The unlimited majority must never pay a blob read.
      snapshot.policy = policyWith([
        ...LIFT_COMPILED_COUNTERS,
        { limitKey: 'feature.webSearch.enabled', value: false },
        { limitKey: 'feature.upload.megabytesPerFile', value: 20 },
        { limitKey: 'chat.messagesPerDay', value: null },
      ]);
      const data = await get('usage=1&models=o3,gpt-5.2');
      expect(readUsage).not.toHaveBeenCalled();
      expect(data).not.toHaveProperty('usageUnavailable');
      expect(limitFor(data, 'feature.webSearch.enabled')).toMatchObject({
        value: false,
      });
      expect(data.models).toEqual({
        o3: { allowed: true },
        'gpt-5.2': { allowed: true },
      });
    });

    it('with an EMPTY policy the compiled numeric defaults do NOT trigger a day-ledger read, and are dropped from limits[]', async () => {
      // Catalog-sourced numeric defaults (the flag-gated M365 budgets) must
      // not force storage for a caller with no authored policy at all — the
      // zero-storage path has to actually be reachable. Dropped from the
      // response too: showing "M365 tool calls 0/200" to someone who has
      // never touched the flag-gated feature would be a phantom budget.
      expect(LIFT_COMPILED_COUNTERS.length).toBeGreaterThan(0);
      ledgers({ 'feature.m365.toolCallsPerDay': 3 });
      const data = await get('usage=1');
      expect(readUsage).not.toHaveBeenCalled();
      expect(data).not.toHaveProperty('usageUnavailable');
      expect(limitFor(data, 'feature.m365.toolCallsPerDay')).toBeUndefined();
    });

    it('a catalog-sourced numeric default rides along for free once a REAL counter forces the same ledger open', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
      ]);
      ledgers({ 'chat.messagesPerDay': 7, 'feature.m365.toolCallsPerDay': 3 });
      const data = await get('usage=1');
      expect(readUsage).toHaveBeenCalledTimes(1);
      expect(limitFor(data, 'feature.m365.toolCallsPerDay')).toMatchObject({
        value: 200,
        used: 3,
        remaining: 197,
      });
    });

    it('a catalog-sourced numeric default is still dropped when the ledger read fails', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
      ]);
      vi.mocked(readUsage).mockRejectedValue(new Error('blob down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const data = await get('usage=1');
      warn.mockRestore();
      expect(data.usageUnavailable).toBe(true);
      expect(limitFor(data, 'feature.m365.toolCallsPerDay')).toBeUndefined();
      // The real, policy-authored row still shows, cap-only.
      expect(limitFor(data, 'chat.messagesPerDay')).toMatchObject({
        value: 100,
      });
    });

    it('reads the caller’s own counters by session oid in the policy zone and attaches used/remaining/resetAt to numeric counter rows', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
        { limitKey: 'feature.upload.megabytesPerFile', value: 20 },
      ]);
      ledgers({ 'chat.messagesPerDay': 7 });
      const data = await get('usage=1');

      // Direct ledger read, keyed by the oid, never by mail or via Graph.
      expect(readUsage).toHaveBeenCalledTimes(1);
      expect(readUsage).toHaveBeenCalledWith('oid-caller', 'day', {
        timezone: TZ,
      });

      expect(limitFor(data, 'chat.messagesPerDay')).toEqual({
        limitKey: 'chat.messagesPerDay',
        value: 100,
        unit: 'requests',
        window: 'day',
        source: 'global',
        used: 7,
        remaining: 93,
        resetAt: resetAt('day', TZ),
      });
      // A ceiling is not a counter: nothing to attach.
      const ceiling = limitFor(data, 'feature.upload.megabytesPerFile');
      expect(ceiling).toMatchObject({ value: 20 });
      expect(ceiling).not.toHaveProperty('used');
      expect(data).not.toHaveProperty('usageUnavailable');
    });

    it('reads the month ledger only when a month counter is numeric', async () => {
      snapshot.policy = policyWith([
        ...LIFT_COMPILED_COUNTERS,
        { limitKey: 'chat.tokensPerMonth', value: 1_000_000 },
      ]);
      ledgers({}, { 'chat.tokensPerMonth': 250_000 });
      const data = await get('usage=1');
      expect(readUsage).toHaveBeenCalledTimes(1);
      expect(readUsage).toHaveBeenCalledWith('oid-caller', 'month', {
        timezone: TZ,
      });
      expect(limitFor(data, 'chat.tokensPerMonth')).toMatchObject({
        used: 250_000,
        remaining: 750_000,
        resetAt: resetAt('month', TZ),
      });
    });

    it('a missing counter document reads as 0 used, full budget remaining', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
      ]);
      expect(
        limitFor(await get('usage=1'), 'chat.messagesPerDay'),
      ).toMatchObject({ used: 0, remaining: 100 });
    });

    it('never reports negative remaining when the ledger overshoots the cap', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 10 },
      ]);
      ledgers({ 'chat.messagesPerDay': 12 });
      expect(
        limitFor(await get('usage=1'), 'chat.messagesPerDay'),
      ).toMatchObject({ used: 12, remaining: 0 });
    });

    it('answers usageUnavailable: true (still 200, limits intact) when the ledger cannot be read', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
      ]);
      vi.mocked(readUsage).mockRejectedValue(new Error('blob down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const data = await get('usage=1&models=o3');
      warn.mockRestore();
      expect(data.usageUnavailable).toBe(true);
      const row = limitFor(data, 'chat.messagesPerDay');
      expect(row).toMatchObject({ value: 100 });
      expect(row).not.toHaveProperty('used');
      // The model answer falls back to cap-only: never a guessed 0 used.
      expect(data.models.o3).toMatchObject({ allowed: true, limit: 100 });
      expect(data.models.o3).not.toHaveProperty('used');
      expect(data.models.o3).not.toHaveProperty('reason');
    });

    it('reads storage for a MODEL-QUALIFIED per-model cap even when no unqualified row is numeric', async () => {
      // The bare, unqualified `model.requests` row must NOT be what selects
      // the ledger here — it stays null (unlimited), so this test actually
      // exercises the per-model branch of meteredLedgers (a bare numeric
      // default would trigger the day read by itself and mask a regression
      // in the models-driven loop).
      snapshot.policy = policyWith([
        ...LIFT_COMPILED_COUNTERS,
        { limitKey: 'model.requests', modelId: 'o3', value: 50 },
      ]);
      expect(limitFor(await get(''), 'model.requests')).toBeUndefined();
      ledgers({ 'model:o3.requests': 50 });
      const data = await get('usage=1&models=o3');
      expect(readUsage).toHaveBeenCalledTimes(1);
      expect(readUsage).toHaveBeenCalledWith('oid-caller', 'day', {
        timezone: TZ,
      });
      expect(data.models.o3).toMatchObject({
        allowed: true,
        reason: 'exhausted',
        limit: 50,
        used: 50,
        remaining: 0,
      });
    });

    it('the bare (unqualified) model.requests row never carries used/remaining — enforcement writes only model:/family: cells', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'model.requests', value: 100 },
      ]);
      ledgers({ 'model:o3.requests': 100, 'family:o-series.requests': 100 });
      const data = await get('usage=1&models=o3');
      const row = limitFor(data, 'model.requests');
      expect(row).toMatchObject({ value: 100 });
      expect(row).not.toHaveProperty('used');
      expect(row).not.toHaveProperty('remaining');
      // Real consumption is visible only through the per-model answer.
      expect(data.models.o3).toMatchObject({
        reason: 'exhausted',
        used: 100,
        remaining: 0,
      });
    });

    it('a hung ledger read times out at 2.5s and answers usageUnavailable rather than stalling', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 100 },
      ]);
      // Never resolves — simulates a stalled blob GET.
      vi.mocked(readUsage).mockImplementation(() => new Promise(() => {}));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const responsePromise = get('usage=1');
      await vi.advanceTimersByTimeAsync(2_500);
      const data = await responsePromise;
      warn.mockRestore();
      expect(data.usageUnavailable).toBe(true);
      const row = limitFor(data, 'chat.messagesPerDay');
      expect(row).toMatchObject({ value: 100 });
      expect(row).not.toHaveProperty('used');
    });
  });

  describe('models=', () => {
    it('is absent unless asked for; present (possibly empty) when asked', async () => {
      expect(await get('')).not.toHaveProperty('models');
      expect((await get('models=')).models).toEqual({});
      expect((await get('models=byom-x,no-such-model')).models).toEqual({});
    });

    it('accepts only dimension-shaped CATALOG ids; custom-source and unknown ids are skipped', async () => {
      const data = await get(
        'models=o3, gpt-5.2 ,byom-acct-gpt,local-llama,org-x,foundry-y,has space,%3Cscript%3E,o3',
      );
      expect(Object.keys(data.models).sort()).toEqual(['gpt-5.2', 'o3']);
    });

    it('rejects Object.prototype property names — an unguarded index lookup would resolve them as "catalog" ids', async () => {
      const data = await get(
        'models=constructor,toString,valueOf,hasOwnProperty,__proto__,o3',
      );
      expect(Object.keys(data.models).sort()).toEqual(['o3']);
    });

    it('caps the list at 100 ids', async () => {
      const filler = Array.from({ length: 100 }, (_, i) => `nope-${i}`);
      const data = await get(`models=${[...filler, 'o3'].join(',')}`);
      expect(data.models).toEqual({});
    });

    it('a family block hides the member: allowed false, reason blocked, and a model-level allow does not rescue it', async () => {
      // o3/o4-mini (o-series) and gpt-5.2 (Foundational) are all variants of
      // the one `gpt` family, so the block reaches all three; the control has
      // to come from another family entirely.
      snapshot.policy = policyWith([
        { limitKey: 'model.allowed', series: 'gpt', value: false },
        { limitKey: 'model.allowed', modelId: 'o3', value: true },
      ]);
      const data = await get('models=o3,o4-mini,gpt-5.2,claude-sonnet-5');
      expect(data.models).toEqual({
        o3: { allowed: false, reason: 'blocked' },
        'o4-mini': { allowed: false, reason: 'blocked' },
        'gpt-5.2': { allowed: false, reason: 'blocked' },
        'claude-sonnet-5': { allowed: true },
      });
    });

    it('reports observe mode in `mode` and still answers per model — the client applies the mode', async () => {
      snapshot.policy = policyWith(
        [{ limitKey: 'model.allowed', modelId: 'o3', value: false }],
        { mode: 'observe' },
      );
      const data = await get('models=o3');
      expect(data.mode).toBe('observe');
      expect(data.models.o3).toEqual({ allowed: false, reason: 'blocked' });
    });

    it('distinguishes an exhausted model cell from an exhausted family envelope', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'model.requests', modelId: 'o3', value: 50 },
        { limitKey: 'model.requests', series: 'gpt', value: 500 },
      ]);
      ledgers({
        'model:o3.requests': 50,
        'family:gpt.requests': 500,
        'model:gpt-5.2.requests': 3,
      });
      const data = await get('usage=1&models=o3,gpt-5.2,gpt-4.1');
      expect(data.models.o3).toMatchObject({
        reason: 'exhausted',
        limit: 50,
        used: 50,
        remaining: 0,
      });
      // Every member of the family carries the envelope's reason.
      expect(data.models['gpt-5.2']).toMatchObject({
        reason: 'familyExhausted',
        limit: 500,
        remaining: 0,
        resetAt: resetAt('day', TZ),
      });
      expect(data.models['gpt-4.1']).toMatchObject({
        reason: 'familyExhausted',
      });
    });

    it('the unqualified message cap binds every model', async () => {
      snapshot.policy = policyWith([
        { limitKey: 'chat.messagesPerDay', value: 20 },
      ]);
      ledgers({ 'chat.messagesPerDay': 15 });
      const data = await get('usage=1&models=o3,gpt-5.2');
      expect(data.models.o3).toMatchObject({ limit: 20, remaining: 5 });
      expect(data.models['gpt-5.2']).toMatchObject({ limit: 20, remaining: 5 });
      expect(data.models.o3).not.toHaveProperty('reason');
    });
  });

  it('keeps the no-provenance promise with both params on', async () => {
    snapshot.policy = policyWith([
      { limitKey: 'chat.messagesPerDay', value: 100 },
    ]);
    const data = await get('usage=1&models=o3');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('"tier"');
    expect(serialized).not.toContain('ceilingLabel');
    expect(serialized).not.toContain('ceilingOverrideId');
  });

  it('the ?as= preview ignores models= and keeps its own usage path', async () => {
    mockAuth.mockResolvedValue({
      user: { id: 'oid-global', mail: 'global@example.com' },
    });
    const data = await get('as=alice@msf.org&models=o3');
    expect(data.preview).toBe(true);
    expect(data).not.toHaveProperty('models');
    expect(readUsage).not.toHaveBeenCalled();
  });
});
