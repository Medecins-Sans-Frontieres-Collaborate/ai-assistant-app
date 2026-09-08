/**
 * modelAvailability.ts — the pure per-model answer the picker consumes
 * (docs/LIMITS_USER_FACING_UX.md §7.1). What matters here is that it mirrors
 * ENFORCEMENT cell for cell: conjunctive model + family gate (so a
 * model-level allow cannot rescue a family block, the divergence §2a.4
 * describes), the same counter set the middleware reserves, read back under
 * the same cell names, and the same byom exemption — while applying no mode
 * and touching no storage.
 */
import {
  isModelBlocked,
  resolveModelAvailability,
} from '@/lib/services/limits/modelAvailability';
import { resetAt } from '@/lib/services/limits/periods';
import { counterCellName } from '@/lib/services/limits/resolver';
import {
  LimitEntry,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alice: Principal = {
  userId: 'oid-alice',
  mail: 'alice@msf.org',
  domain: 'msf.org',
  attributes: [],
  groupIds: [],
};

const O3 = { id: 'o3', series: 'o-series' };
const GPT52 = { id: 'gpt-5.2', series: 'gpt' };
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
    updatedBy: 'test',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

const NO_USAGE = { day: {}, month: {} };

// periods.resetAt walks forward from `now`, so two calls a millisecond apart
// disagree in the last digit; pin the clock so expected and actual agree.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isModelBlocked', () => {
  it('answers false with no policy and with an all-default policy', () => {
    expect(isModelBlocked(null, alice, O3.id, O3.series)).toBe(false);
    expect(isModelBlocked(policyWith([]), alice, O3.id, O3.series)).toBe(false);
  });

  it('a family block hides every member', () => {
    const policy = policyWith([
      { limitKey: 'model.allowed', series: 'o-series', value: false },
    ]);
    expect(isModelBlocked(policy, alice, 'o3', 'o-series')).toBe(true);
    expect(isModelBlocked(policy, alice, 'o4-mini', 'o-series')).toBe(true);
    expect(isModelBlocked(policy, alice, GPT52.id, GPT52.series)).toBe(false);
  });

  it('a model-level allow does NOT rescue a family block (conjunctive, as checkGate)', () => {
    // The old single-cell filter resolved (modelId, series) together and let
    // the more specific `true` shadow the family `false`; enforcement never
    // did, and the picker must agree with the send.
    const policy = policyWith([
      { limitKey: 'model.allowed', series: 'o-series', value: false },
      { limitKey: 'model.allowed', modelId: 'o3', value: true },
    ]);
    expect(isModelBlocked(policy, alice, 'o3', 'o-series')).toBe(true);
  });

  it('a model block alone hides only that model', () => {
    const policy = policyWith([
      { limitKey: 'model.allowed', modelId: 'o3', value: false },
    ]);
    expect(isModelBlocked(policy, alice, 'o3', 'o-series')).toBe(true);
    expect(isModelBlocked(policy, alice, 'o4-mini', 'o-series')).toBe(false);
  });

  it('falls back to the unqualified resolution when the model yields no valid cell', () => {
    // An id that fails the dimension check and no series → no model cell, no
    // family cell → the bare answer still applies (checkGate does the same).
    const policy = policyWith([{ limitKey: 'model.allowed', value: false }]);
    expect(isModelBlocked(policy, alice, 'not a valid id!', undefined)).toBe(
      true,
    );
    expect(isModelBlocked(policy, alice, undefined, undefined)).toBe(true);
    // ...and an unqualified `false` blocks a fully qualified model too.
    expect(isModelBlocked(policy, alice, O3.id, O3.series)).toBe(true);
  });

  it('is mode-agnostic: observe mode still answers "would block" (the caller applies the mode)', () => {
    const policy = policyWith(
      [{ limitKey: 'model.allowed', series: 'o-series', value: false }],
      { mode: 'observe' },
    );
    expect(isModelBlocked(policy, alice, 'o3', 'o-series')).toBe(true);
  });

  it('exempts byom- models unless the policy counts byom usage', () => {
    const blockAll = [{ limitKey: 'model.allowed', value: false }];
    expect(isModelBlocked(policyWith(blockAll), alice, 'byom-x', 'gpt')).toBe(
      false,
    );
    expect(
      isModelBlocked(
        policyWith(blockAll, { countByomUsage: true }),
        alice,
        'byom-x',
        'gpt',
      ),
    ).toBe(true);
  });
});

describe('resolveModelAvailability', () => {
  it('a blocked model reports only { allowed: false, reason: "blocked" } — no counters', () => {
    const policy = policyWith([
      { limitKey: 'model.allowed', series: 'o-series', value: false },
      { limitKey: 'model.requests', value: 10 },
    ]);
    expect(resolveModelAvailability(policy, alice, O3, NO_USAGE, TZ)).toEqual({
      allowed: false,
      reason: 'blocked',
    });
  });

  it('with nothing numeric answers a bare { allowed: true }', () => {
    expect(resolveModelAvailability(null, alice, O3, NO_USAGE, TZ)).toEqual({
      allowed: true,
    });
    expect(
      resolveModelAvailability(policyWith([]), alice, O3, null, TZ),
    ).toEqual({ allowed: true });
  });

  it('reports the binding cell with remaining and resetAt, under the same cell names the debit path writes', () => {
    const policy = policyWith([
      { limitKey: 'chat.messagesPerDay', value: 100 },
      { limitKey: 'model.requests', modelId: 'o3', value: 50 },
    ]);
    const usage = {
      day: {
        'chat.messagesPerDay': 10,
        [counterCellName({ limitKey: 'model.requests', modelId: 'o3' })]: 45,
      },
      month: {},
    };
    const out = resolveModelAvailability(policy, alice, O3, usage, TZ);
    expect(out).toMatchObject({
      allowed: true,
      limit: 50,
      used: 45,
      remaining: 5,
    });
    expect(out.reason).toBeUndefined();
    // The day boundary in the policy's zone, as enforcement would report it.
    expect(out.resetAt).toBe(resetAt('day', TZ));
  });

  it('reason "exhausted" when the MODEL cell is at zero remaining', () => {
    const policy = policyWith([
      { limitKey: 'model.requests', value: 100 }, // → model AND family cells
    ]);
    const usage = {
      day: { 'model:o3.requests': 100, 'family:o-series.requests': 100 },
      month: {},
    };
    // Both at zero: the model sub-cap wins the tie, so the copy says "this
    // model", not "your o-series budget".
    expect(
      resolveModelAvailability(policy, alice, O3, usage, TZ),
    ).toMatchObject({
      allowed: true,
      reason: 'exhausted',
      limit: 100,
      used: 100,
      remaining: 0,
    });
  });

  it('reason "familyExhausted" when ONLY the family envelope is used up', () => {
    const policy = policyWith([
      { limitKey: 'model.requests', modelId: 'o3', value: 50 },
      { limitKey: 'model.requests', series: 'o-series', value: 80 },
    ]);
    const usage = {
      day: { 'model:o3.requests': 20, 'family:o-series.requests': 80 },
      month: {},
    };
    expect(
      resolveModelAvailability(policy, alice, O3, usage, TZ),
    ).toMatchObject({
      allowed: true,
      reason: 'familyExhausted',
      limit: 80,
      used: 80,
      remaining: 0,
    });
  });

  it('reason "exhausted" when the unqualified message cap is at zero, even with model budget left', () => {
    const policy = policyWith([
      { limitKey: 'chat.messagesPerDay', value: 20 },
      { limitKey: 'model.requests', modelId: 'o3', value: 50 },
    ]);
    const usage = {
      day: { 'chat.messagesPerDay': 20, 'model:o3.requests': 1 },
      month: {},
    };
    expect(
      resolveModelAvailability(policy, alice, O3, usage, TZ),
    ).toMatchObject({
      allowed: true,
      reason: 'exhausted',
      limit: 20,
      remaining: 0,
    });
  });

  it('a missing counter document means a full budget, not an unknown one', () => {
    const policy = policyWith([
      { limitKey: 'model.requests', modelId: 'o3', value: 50 },
    ]);
    expect(
      resolveModelAvailability(policy, alice, O3, NO_USAGE, TZ),
    ).toMatchObject({ allowed: true, limit: 50, used: 0, remaining: 50 });
  });

  it('without usage (null) reports the cap and reset but no consumption and no reason', () => {
    const policy = policyWith([
      { limitKey: 'model.requests', modelId: 'o3', value: 50 },
    ]);
    const out = resolveModelAvailability(policy, alice, O3, null, TZ);
    expect(out).toMatchObject({ allowed: true, limit: 50 });
    expect(out.resetAt).toBe(resetAt('day', TZ));
    expect(out).not.toHaveProperty('used');
    expect(out).not.toHaveProperty('remaining');
    expect(out).not.toHaveProperty('reason');
  });

  it('a model with no series has no family cell and is never folded into one', () => {
    const policy = policyWith([
      { limitKey: 'model.requests', series: 'gpt', value: 0 },
    ]);
    expect(
      resolveModelAvailability(policy, alice, { id: 'gpt-5.2' }, NO_USAGE, TZ),
    ).toEqual({ allowed: true });
  });

  it('mirrors the byom exemption: no gate, no per-model counters, but the message cap still binds', () => {
    const policy = policyWith([
      { limitKey: 'model.allowed', value: false },
      { limitKey: 'model.requests', value: 0 },
      { limitKey: 'chat.messagesPerDay', value: 30 },
    ]);
    const byom = { id: 'byom-acct-gpt-5.2', series: 'gpt' };
    const usage = { day: { 'chat.messagesPerDay': 12 }, month: {} };
    expect(resolveModelAvailability(policy, alice, byom, usage, TZ)).toEqual({
      allowed: true,
      limit: 30,
      used: 12,
      remaining: 18,
      resetAt: resetAt('day', TZ),
    });
    // Opted in: the model is now subject to the gate like any other.
    const counted = policyWith(policy.defaults, { countByomUsage: true });
    expect(resolveModelAvailability(counted, alice, byom, usage, TZ)).toEqual({
      allowed: false,
      reason: 'blocked',
    });
  });

  it('an exhausted DAY token budget grays every model, even one with room on every other cell', () => {
    // checkTokenBudget refuses the send outright once the day cap is hit,
    // regardless of model — the picker must agree instead of showing every
    // model available right up until the 403.
    const policy = policyWith([
      { limitKey: 'chat.tokensPerDay', value: 100_000 },
      { limitKey: 'model.requests', modelId: 'o3', value: 50 },
    ]);
    const usage = {
      day: { 'chat.tokensPerDay': 100_000, 'model:o3.requests': 1 },
      month: {},
    };
    expect(
      resolveModelAvailability(policy, alice, O3, usage, TZ),
    ).toMatchObject({
      allowed: true,
      reason: 'exhausted',
      limit: 100_000,
      used: 100_000,
      remaining: 0,
    });
  });

  it('an exhausted MONTH token budget binds too, with a month resetAt', () => {
    const policy = policyWith([
      { limitKey: 'chat.tokensPerMonth', value: 1_000_000 },
    ]);
    const usage = {
      day: {},
      month: { 'chat.tokensPerMonth': 1_000_000 },
    };
    expect(
      resolveModelAvailability(policy, alice, O3, usage, TZ),
    ).toMatchObject({
      allowed: true,
      reason: 'exhausted',
      limit: 1_000_000,
      remaining: 0,
      resetAt: resetAt('month', TZ),
    });
  });

  it('token budgets are never byom-exempt: they bind a byom model like any other', () => {
    const policy = policyWith([
      { limitKey: 'chat.tokensPerDay', value: 50_000 },
    ]);
    const byom = { id: 'byom-acct-gpt-5.2', series: 'gpt' };
    const usage = { day: { 'chat.tokensPerDay': 50_000 }, month: {} };
    expect(
      resolveModelAvailability(policy, alice, byom, usage, TZ),
    ).toMatchObject({ allowed: true, reason: 'exhausted', remaining: 0 });
  });

  it('a token budget with room does not shadow a real per-model exhaustion', () => {
    const policy = policyWith([
      { limitKey: 'chat.tokensPerDay', value: 100_000 },
      { limitKey: 'model.requests', modelId: 'o3', value: 10 },
    ]);
    const usage = {
      day: { 'chat.tokensPerDay': 1_000, 'model:o3.requests': 10 },
      month: {},
    };
    expect(
      resolveModelAvailability(policy, alice, O3, usage, TZ),
    ).toMatchObject({
      allowed: true,
      reason: 'exhausted',
      limit: 10,
      used: 10,
      remaining: 0,
    });
  });
});
