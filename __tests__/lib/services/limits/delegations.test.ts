/**
 * Scoped-admin delegations in the resolver (docs/LIMITS_SCOPED_ADMINS_DESIGN.md
 * §3): containment, authority tier, and the by-tier rules that stored data can
 * never out-vote. The plain comparator and ceiling behaviour for policies
 * WITHOUT delegations is pinned in resolver.test.ts.
 */
import {
  activeDelegationIds,
  resolveAllLimits,
  resolveLimit,
  resolveModelCells,
  setJurisdictionDegradedCheck,
  withinJurisdiction,
} from '@/lib/services/limits/resolver';
import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
  OverrideScope,
} from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { getLimitDefinition } from '@/config/limits';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CHAT_MESSAGES = getLimitDefinition('chat.messagesPerDay')!;
const MODEL_REQUESTS = getLimitDefinition('model.requests')!;

const GROUP_A = '00000000-0000-0000-0000-00000000000a';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'oid-1',
    mail: 'ada@example.org',
    domain: 'example.org',
    attributes: ['department:health', 'office:msf-usa'],
    groupIds: [],
    ...overrides,
  };
}

let idCounter = 0;
function override(
  scope: OverrideScope,
  targets: string[],
  entries: Partial<LimitEntry>[],
  extra: Partial<LimitOverride> = {},
): LimitOverride {
  idCounter += 1;
  const id = `lim-${idCounter.toString(16).padStart(12, '0')}`;
  return {
    id,
    label: '',
    enabled: true,
    scope,
    targets,
    priority: 0,
    entries: entries.map((e) => ({
      limitKey: 'chat.messagesPerDay',
      value: null,
      ceiling: false,
      ...e,
    })) as LimitEntry[],
    createdBy: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

let delIdCounter = 0;
function delegation(
  jurisdiction: JurisdictionPredicate[],
  extra: Partial<LimitDelegation> = {},
): LimitDelegation {
  delIdCounter += 1;
  return {
    id: `del-${delIdCounter.toString(16).padStart(12, '0')}`,
    label: '',
    enabled: true,
    admins: ['ocp-admin@example.org'],
    jurisdiction,
    maxOverrides: 25,
    createdBy: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function policy(
  defaults: Partial<LimitEntry>[],
  overrides: LimitOverride[] = [],
  extra: Partial<LimitsPolicy> = {},
): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: defaults.map((e) => ({
      limitKey: 'chat.messagesPerDay',
      value: null,
      ceiling: false,
      ...e,
    })),
    overrides,
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

/** A delegation over example.org, and a scoped override authored under it. */
function scopedFixture(
  scope: OverrideScope,
  targets: string[],
  entries: Partial<LimitEntry>[],
  extra: Partial<LimitOverride> = {},
) {
  const del = delegation([{ scope: 'domain', targets: ['example.org'] }]);
  const scoped = override(scope, targets, entries, {
    delegationId: del.id,
    ...extra,
  });
  return { del, scoped };
}

describe('withinJurisdiction / activeDelegationIds', () => {
  it('OR-s predicates and treats an empty jurisdiction as matching nobody', () => {
    expect(withinJurisdiction(delegation([]), principal())).toBe(false);
    const either = delegation([
      { scope: 'domain', targets: ['other.org'] },
      { scope: 'user', targets: ['ada@example.org'] },
    ]);
    expect(withinJurisdiction(either, principal())).toBe(true);
    expect(
      withinJurisdiction(
        either,
        principal({ mail: 'bob@example.org', domain: 'example.org' }),
      ),
    ).toBe(false);
  });

  it('withinJurisdiction ignores `enabled`; activeDelegationIds honours it', () => {
    const disabled = delegation(
      [{ scope: 'domain', targets: ['example.org'] }],
      { enabled: false },
    );
    const enabled = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const foreign = delegation([{ scope: 'domain', targets: ['other.org'] }]);
    expect(withinJurisdiction(disabled, principal())).toBe(true);
    const active = activeDelegationIds(
      policy([], [], { delegations: [disabled, enabled, foreign] }),
      principal(),
    );
    expect([...active]).toEqual([enabled.id]);
  });

  it('returns an empty set for a missing policy', () => {
    expect(activeDelegationIds(null, principal()).size).toBe(0);
  });
});

describe('resolveLimit — containment', () => {
  it('a scoped override inside its jurisdiction applies and is reported as tier "scoped"', () => {
    const { del, scoped } = scopedFixture(
      'user',
      ['ada@example.org'],
      [{ value: 500 }],
    );
    const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result).toMatchObject({
      value: 500,
      source: 'user',
      tier: 'scoped',
      overrideId: scoped.id,
    });
  });

  it('a principal OUTSIDE the jurisdiction is untouched even when the targets name them', () => {
    // Jurisdiction is other.org; the override targets ada@example.org.
    const del = delegation([{ scope: 'domain', targets: ['other.org'] }]);
    const scoped = override('user', ['ada@example.org'], [{ value: 500 }], {
      delegationId: del.id,
    });
    const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result).toMatchObject({
      value: 100,
      source: 'global',
      tier: 'global',
    });
    expect(result.overrideId).toBeUndefined();
  });

  it('a scoped domain override applies to jurisdiction members and to nobody else', () => {
    const { del, scoped } = scopedFixture(
      'domain',
      ['example.org', 'other.org'],
      [{ value: 5 }],
    );
    const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(5);
    const outsider = principal({ mail: 'zed@other.org', domain: 'other.org' });
    expect(resolveLimit(CHAT_MESSAGES, p, outsider).value).toBe(100);
  });

  it('an override whose delegationId is ORPHANED is inert, never promoted to global', () => {
    const scoped = override('user', ['ada@example.org'], [{ value: 500 }], {
      delegationId: 'del-00000000dead',
    });
    const p = policy([{ value: 100 }], [scoped], { delegations: [] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal())).toMatchObject({
      value: 100,
      source: 'global',
    });
  });

  it('an override under a DISABLED delegation is inert', () => {
    const del = delegation([{ scope: 'domain', targets: ['example.org'] }], {
      enabled: false,
    });
    const scoped = override('user', ['ada@example.org'], [{ value: 500 }], {
      delegationId: del.id,
    });
    const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(100);
  });

  it('cross-axis: an attribute override under a domain jurisdiction applies to the INTERSECTION', () => {
    const { del, scoped } = scopedFixture(
      'attribute',
      ['department:health'],
      [{ value: 7 }],
    );
    const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
    // health ∩ example.org → applies.
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(7);
    // health but NOT example.org → untouched.
    const otherHealth = principal({
      mail: 'carol@other.org',
      domain: 'other.org',
    });
    expect(resolveLimit(CHAT_MESSAGES, p, otherHealth).value).toBe(100);
    // example.org but NOT health → untouched (the override's own targets).
    const finance = principal({ attributes: ['department:finance'] });
    expect(resolveLimit(CHAT_MESSAGES, p, finance).value).toBe(100);
  });

  it('a group-anchored jurisdiction only contains principals whose cached groups include it', () => {
    const del = delegation([{ scope: 'group', targets: [GROUP_A] }]);
    const scoped = override('user', ['ada@example.org'], [{ value: 500 }], {
      delegationId: del.id,
    });
    const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(100);
    expect(
      resolveLimit(CHAT_MESSAGES, p, principal({ groupIds: [GROUP_A] })).value,
    ).toBe(500);
  });

  it('narrowing a jurisdiction makes existing overrides inert immediately, no migration', () => {
    const del = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const scoped = override('user', ['ada@example.org'], [{ value: 500 }], {
      delegationId: del.id,
    });
    const wide = policy([{ value: 100 }], [scoped], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, wide, principal()).value).toBe(500);

    const narrowed = policy([{ value: 100 }], [scoped], {
      delegations: [
        {
          ...del,
          jurisdiction: [{ scope: 'user', targets: ['bob@example.org'] }],
        },
      ],
    });
    expect(resolveLimit(CHAT_MESSAGES, narrowed, principal()).value).toBe(100);
  });

  it('containment holds through resolveAllLimits and resolveModelCells (precomputed path)', () => {
    const del = delegation([{ scope: 'domain', targets: ['other.org'] }]);
    const scoped = override(
      'user',
      ['ada@example.org'],
      [
        { value: 500 },
        { limitKey: MODEL_REQUESTS.key, modelId: 'gpt-5.2', value: 999 },
      ],
      { delegationId: del.id },
    );
    const p = policy(
      [{ value: 100 }, { limitKey: MODEL_REQUESTS.key, value: 10 }],
      [scoped],
      { delegations: [del] },
    );
    const all = resolveAllLimits(p, principal());
    expect(all[CHAT_MESSAGES.key]).toMatchObject({
      value: 100,
      tier: 'global',
    });
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      p,
      principal(),
      'gpt-5.2',
      'gpt',
    );
    expect(cells.map((c) => c.value)).toEqual([10, 10]);

    // And the positive side through the same paths.
    const inside = principal({ mail: 'ada@other.org', domain: 'other.org' });
    const scopedForInside = override(
      'user',
      ['ada@other.org'],
      [{ limitKey: MODEL_REQUESTS.key, modelId: 'gpt-5.2', value: 999 }],
      { delegationId: del.id },
    );
    const p2 = policy(
      [{ limitKey: MODEL_REQUESTS.key, value: 10 }],
      [scopedForInside],
      { delegations: [del] },
    );
    const cells2 = resolveModelCells(
      MODEL_REQUESTS,
      p2,
      inside,
      'gpt-5.2',
      'gpt',
    );
    expect(cells2.map((c) => c.value)).toEqual([999, 10]);
  });

  it('a policy with delegations but only GLOBAL-tier overrides resolves as if it had none', () => {
    const del = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const overrides = [
      override('domain', ['example.org'], [{ value: 200 }]),
      override('user', ['ada@example.org'], [{ value: 400 }]),
    ];
    const plain = policy([{ value: 100 }], overrides);
    const withDel = policy([{ value: 100 }], overrides, { delegations: [del] });
    expect(resolveAllLimits(withDel, principal())).toEqual(
      resolveAllLimits(plain, principal()),
    );
  });
});

describe('resolveLimit — authority tier', () => {
  it('at the same layer a global record beats a scoped one even with a higher STORED priority', () => {
    const { del, scoped } = scopedFixture(
      'domain',
      ['example.org'],
      [{ value: 1 }],
      { priority: 1000 },
    );
    const global = override('domain', ['example.org'], [{ value: 500 }]);
    const p = policy([], [scoped, global], { delegations: [del] });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result).toMatchObject({
      value: 500,
      overrideId: global.id,
      tier: 'global',
    });
  });

  it('at the same layer a global record beats a scoped one that is MORE model-specific', () => {
    const { del, scoped } = scopedFixture(
      'domain',
      ['example.org'],
      [{ limitKey: MODEL_REQUESTS.key, modelId: 'gpt-5.2', value: 1 }],
    );
    const global = override(
      'domain',
      ['example.org'],
      [{ limitKey: MODEL_REQUESTS.key, value: 500 }],
    );
    const p = policy([], [scoped, global], { delegations: [del] });
    expect(
      resolveLimit(MODEL_REQUESTS, p, principal(), 'gpt-5.2'),
    ).toMatchObject({ value: 500, overrideId: global.id });
  });

  it('at the same layer a global record beats a scoped one that is MORE restrictive', () => {
    const { del, scoped } = scopedFixture(
      'domain',
      ['example.org'],
      [{ value: 1 }],
    );
    const global = override('domain', ['example.org'], [{ value: 500 }]);
    const p = policy([], [global, scoped], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(500);
  });

  it('tier ordering holds at EVERY layer (domain, attribute, group, user)', () => {
    const del = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const cases: Array<[OverrideScope, string[]]> = [
      ['domain', ['example.org']],
      ['attribute', ['department:health']],
      ['group', [GROUP_A]],
      ['user', ['ada@example.org']],
    ];
    for (const [scope, targets] of cases) {
      const scoped = override(scope, targets, [{ value: 1 }], {
        delegationId: del.id,
        priority: 999,
      });
      const global = override(scope, targets, [{ value: 500 }]);
      const p = policy([], [scoped, global], { delegations: [del] });
      const result = resolveLimit(
        CHAT_MESSAGES,
        p,
        principal({ groupIds: [GROUP_A] }),
      );
      expect(result, scope).toMatchObject({ value: 500, tier: 'global' });
    }
  });

  it('cross-layer is UNCHANGED: a scoped user override beats a global domain override without ceiling', () => {
    const { del, scoped } = scopedFixture(
      'user',
      ['ada@example.org'],
      [{ value: 500 }],
    );
    const globalDomain = override('domain', ['example.org'], [{ value: 100 }]);
    const p = policy([{ value: 50 }], [globalDomain, scoped], {
      delegations: [del],
    });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result).toMatchObject({
      value: 500,
      source: 'user',
      tier: 'scoped',
      overrideId: scoped.id,
    });
    expect(result.ceilingApplied).toBeUndefined();
  });

  it('…but a global domain override WITH ceiling pins the scoped user override', () => {
    const { del, scoped } = scopedFixture(
      'user',
      ['ada@example.org'],
      [{ value: 500 }],
    );
    const globalDomain = override(
      'domain',
      ['example.org'],
      [{ value: 100, ceiling: true }],
    );
    const p = policy([], [globalDomain, scoped], { delegations: [del] });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(100);
    expect(result.ceilingApplied).toBe(true);
    expect(result.ceilingOverrideId).toBe(globalDomain.id);
    expect(result.tier).toBe('scoped');
  });

  it('a scoped override cannot exceed a global DEFAULT ceiling', () => {
    const { del, scoped } = scopedFixture(
      'user',
      ['ada@example.org'],
      [{ value: null }],
    );
    const p = policy([{ value: 100, ceiling: true }], [scoped], {
      delegations: [del],
    });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(100);
    expect(result.ceilingApplied).toBe(true);
    expect(result.ceilingOverrideId).toBeUndefined();
  });

  it('a scoped override may lower, raise or unlimit a non-ceiling global default', () => {
    for (const value of [5, 5000, null]) {
      const { del, scoped } = scopedFixture(
        'user',
        ['ada@example.org'],
        [{ value }],
      );
      const p = policy([{ value: 100 }], [scoped], { delegations: [del] });
      expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(value);
    }
  });

  it('stored `priority` on a scoped override is compared as 0 — restrictiveness decides among scoped peers', () => {
    const del = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const loud = override('domain', ['example.org'], [{ value: 900 }], {
      delegationId: del.id,
      priority: 1000,
    });
    const quiet = override('domain', ['example.org'], [{ value: 7 }], {
      delegationId: del.id,
      priority: 0,
    });
    const p = policy([], [loud, quiet], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal())).toMatchObject({
      value: 7,
      overrideId: quiet.id,
    });
  });

  it('stored `ceiling: true` on a scoped override pins NOTHING', () => {
    const { del, scoped } = scopedFixture(
      'domain',
      ['example.org'],
      [{ value: 10, ceiling: true }],
    );
    const globalUser = override('user', ['ada@example.org'], [{ value: 900 }]);
    const p = policy([], [scoped, globalUser], { delegations: [del] });
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(900);
    expect(result.ceilingApplied).toBeUndefined();
    expect(result.ceilingOverrideId).toBeUndefined();

    // Nor does it pin another scoped record at a more specific layer.
    const scopedUser = override('user', ['ada@example.org'], [{ value: 800 }], {
      delegationId: del.id,
    });
    const p2 = policy([], [scoped, scopedUser], { delegations: [del] });
    expect(resolveLimit(CHAT_MESSAGES, p2, principal()).value).toBe(800);
  });

  it('two overlapping delegations tie-break as today: more restrictive, then smallest id', () => {
    const a = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const b = delegation([
      { scope: 'attribute', targets: ['department:health'] },
    ]);
    const fromA = override('domain', ['example.org'], [{ value: 300 }], {
      delegationId: a.id,
    });
    const fromB = override('domain', ['example.org'], [{ value: 30 }], {
      delegationId: b.id,
    });
    const p = policy([], [fromA, fromB], { delegations: [a, b] });
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).overrideId).toBe(
      fromB.id,
    );

    const twinA = override('domain', ['example.org'], [{ value: 30 }], {
      delegationId: a.id,
    });
    const twinB = override('domain', ['example.org'], [{ value: 30 }], {
      delegationId: b.id,
    });
    const expected = [twinA.id, twinB.id].sort()[0];
    const tie = policy([], [twinB, twinA], { delegations: [a, b] });
    expect(resolveLimit(CHAT_MESSAGES, tie, principal()).overrideId).toBe(
      expected,
    );
  });

  it('produces identical output under SHUFFLED order with a tier mix', () => {
    const del = delegation([{ scope: 'domain', targets: ['example.org'] }]);
    const scopedDomain = override('domain', ['example.org'], [{ value: 1 }], {
      delegationId: del.id,
      priority: 500,
    });
    const globalDomain = override('domain', ['example.org'], [{ value: 200 }]);
    const scopedUser = override('user', ['ada@example.org'], [{ value: 800 }], {
      delegationId: del.id,
    });
    const orders = [
      [scopedDomain, globalDomain, scopedUser],
      [scopedUser, scopedDomain, globalDomain],
      [globalDomain, scopedUser, scopedDomain],
    ];
    for (const overrides of orders) {
      const result = resolveLimit(
        CHAT_MESSAGES,
        policy([{ value: 100 }], overrides, { delegations: [del] }),
        principal(),
      );
      expect(result).toMatchObject({ value: 800, overrideId: scopedUser.id });
    }
  });
});

describe('activeDelegationIds — jurisdiction-unevaluable audit line', () => {
  afterEach(() => {
    setJurisdictionDegradedCheck(undefined);
    vi.restoreAllMocks();
  });

  function groupOnlyPolicy() {
    const del = delegation([{ scope: 'group', targets: [GROUP_A] }]);
    const scoped = override('user', ['ada@example.org'], [{ value: 500 }], {
      delegationId: del.id,
    });
    return {
      del,
      p: policy([{ value: 100 }], [scoped], { delegations: [del] }),
    };
  }

  it('logs once per resolution pass when a group-anchored jurisdiction failed only because membership is degraded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setJurisdictionDegradedCheck((userId) => userId === 'oid-1');
    const { del, p } = groupOnlyPolicy();
    resolveAllLimits(p, principal());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      '[limits-audit] jurisdiction-unevaluable',
    );
    expect(warn.mock.calls[0][0]).toContain(`delegation=${del.id}`);
    expect(warn.mock.calls[0][0]).toContain('user=oid-1');
  });

  it('stays silent when membership is healthy, when the user has groups, or when no check is wired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p } = groupOnlyPolicy();
    resolveAllLimits(p, principal()); // no check wired
    setJurisdictionDegradedCheck(() => false);
    resolveAllLimits(p, principal()); // healthy
    setJurisdictionDegradedCheck(() => true);
    resolveAllLimits(p, principal({ groupIds: ['some-other-group'] })); // evaluated, just not a member
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent for domain/user-anchored jurisdictions and for disabled delegations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setJurisdictionDegradedCheck(() => true);
    const domainDel = delegation([{ scope: 'domain', targets: ['other.org'] }]);
    const disabledGroupDel = delegation(
      [{ scope: 'group', targets: [GROUP_A] }],
      { enabled: false },
    );
    resolveAllLimits(
      policy([], [], { delegations: [domainDel, disabledGroupDel] }),
      principal(),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
