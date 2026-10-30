/**
 * Model approval rules (docs/LIMITS.md "Model approval"): the pure expansion
 * into resolver candidates, and the precedence that falls out of it when the
 * resolver reads the effective arrays.
 */
import { checkGate } from '@/lib/services/limits/enforcement';
import {
  describeModelAccessOverrideId,
  expandModelAccess,
  isModelAccessOverrideId,
  modelAccessDimension,
} from '@/lib/services/limits/modelAccess';
import { isModelBlocked } from '@/lib/services/limits/modelAvailability';
import {
  counterCellName,
  effectiveDefaults,
  effectiveOverrides,
  resolveModelCells,
  resolveModelGate,
} from '@/lib/services/limits/resolver';
import {
  LimitsPolicy,
  LimitsPolicySchema,
  ModelAccessRule,
} from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { getLimitDefinition } from '@/config/limits';
import { describe, expect, it } from 'vitest';

const MODEL_ALLOWED = getLimitDefinition('model.allowed')!;
const MODEL_REQUESTS = getLimitDefinition('model.requests')!;

const alice: Principal = {
  userId: 'oid-alice',
  mail: 'alice@msf.org',
  domain: 'msf.org',
  attributes: [],
  groupIds: ['g-research'],
};
const bob: Principal = {
  userId: 'oid-bob',
  mail: 'bob@ocp.msf.org',
  domain: 'ocp.msf.org',
  attributes: [],
  groupIds: [],
};

function policyWith(
  modelAccess: ModelAccessRule[],
  extra: Partial<LimitsPolicy> = {},
): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: [],
    overrides: [],
    modelAccess,
    mode: 'enforce',
    updatedBy: 'test',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

const rule = (partial: Partial<ModelAccessRule>): ModelAccessRule => ({
  groups: [],
  domains: [],
  allow: [],
  deny: [],
  ...partial,
});

describe('expandModelAccess', () => {
  it('turns a node default into qualified global defaults', () => {
    const { defaults } = expandModelAccess([
      rule({ series: 'claude', defaultAccess: false }),
      rule({ modelId: 'claude-sonnet-5', defaultAccess: 20 }),
      rule({ modelId: 'gpt-5.4', defaultAccess: null }),
    ]);
    expect(defaults).toEqual([
      {
        limitKey: 'model.allowed',
        series: 'claude',
        value: false,
        ceiling: false,
      },
      {
        limitKey: 'model.allowed',
        modelId: 'claude-sonnet-5',
        value: true,
        ceiling: false,
      },
      {
        limitKey: 'model.requests',
        modelId: 'claude-sonnet-5',
        value: 20,
        ceiling: false,
      },
      {
        limitKey: 'model.allowed',
        modelId: 'gpt-5.4',
        value: true,
        ceiling: false,
      },
      {
        limitKey: 'model.requests',
        modelId: 'gpt-5.4',
        value: null,
        ceiling: false,
      },
    ]);
  });

  it('groups grants with the same terms into one override per list, and the block list into a user-layer block', () => {
    const { overrides } = expandModelAccess([
      rule({
        series: 'claude',
        groups: [
          { target: 'g-research', requests: null },
          { target: 'g-ops', requests: 50 },
          { target: 'G-Other', requests: 50 },
        ],
        domains: [{ target: 'ocp.msf.org', requests: 10 }],
        allow: [{ target: 'Alice@msf.org', requests: null }],
        deny: ['mallory@msf.org'],
      }),
    ]);
    expect(overrides.map((o) => [o.id, o.scope, o.targets])).toEqual([
      ['model-access:family:claude|groups|unlimited', 'group', ['g-research']],
      ['model-access:family:claude|groups|50', 'group', ['g-ops', 'g-other']],
      ['model-access:family:claude|domains|10', 'domain', ['ocp.msf.org']],
      ['model-access:family:claude|allow|unlimited', 'user', ['alice@msf.org']],
      ['model-access:family:claude|deny|all', 'user', ['mallory@msf.org']],
    ]);
    const deny = overrides.at(-1)!;
    expect(deny.entries).toEqual([
      {
        limitKey: 'model.allowed',
        series: 'claude',
        value: false,
        ceiling: false,
      },
    ]);
    const ops = overrides[1];
    expect(ops.entries).toEqual([
      {
        limitKey: 'model.allowed',
        series: 'claude',
        value: true,
        ceiling: false,
      },
      {
        limitKey: 'model.requests',
        series: 'claude',
        value: 50,
        ceiling: false,
      },
    ]);
    // Global tier, never delegated, never a ceiling.
    for (const override of overrides) {
      expect(override.delegationId).toBeUndefined();
      expect(override.priority).toBe(0);
      expect(override.entries.every((e) => e.ceiling === false)).toBe(true);
    }
  });

  it('synthetic ids are recognisable and describable; a rule without a dimension is skipped', () => {
    expect(modelAccessDimension({ modelId: 'GPT-5.4' })).toBe('model:gpt-5.4');
    expect(modelAccessDimension({ series: 'Claude' })).toBe('family:claude');
    expect(isModelAccessOverrideId('model-access:family:claude|deny|all')).toBe(
      true,
    );
    expect(isModelAccessOverrideId('lim-0000000000aa')).toBe(false);
    expect(
      describeModelAccessOverrideId('model-access:model:o3|groups|50'),
    ).toEqual({
      dimension: 'model:o3',
      list: 'groups',
    });
    expect(describeModelAccessOverrideId('lim-0000000000aa')).toBeNull();
    expect(expandModelAccess([rule({ defaultAccess: false })])).toEqual({
      defaults: [],
      overrides: [],
    });
    expect(expandModelAccess(undefined)).toEqual({
      defaults: [],
      overrides: [],
    });
  });
});

describe('resolver reads the effective policy', () => {
  it('effectiveDefaults / effectiveOverrides append the expansion and memoize per snapshot', () => {
    const policy = policyWith([
      rule({ series: 'claude', defaultAccess: false, deny: ['x@msf.org'] }),
    ]);
    expect(effectiveDefaults(policy)).toHaveLength(1);
    expect(effectiveOverrides(policy)).toHaveLength(1);
    expect(effectiveDefaults(policy)).toBe(effectiveDefaults(policy));
    expect(effectiveDefaults(null)).toEqual([]);
    expect(effectiveOverrides(null)).toEqual([]);
  });

  it('a model inherits its family default unless it sets its own', () => {
    const policy = policyWith([
      rule({ series: 'gpt', defaultAccess: false }),
      rule({ modelId: 'gpt-5.4', defaultAccess: null }),
    ]);
    expect(isModelBlocked(policy, bob, 'gpt-5.4', 'gpt')).toBe(false);
    expect(isModelBlocked(policy, bob, 'gpt-5.2', 'gpt')).toBe(true);
    expect(
      checkGate(policy, bob, 'model.allowed', 'gpt-5.2', 'gpt').allowed,
    ).toBe(false);
    expect(
      checkGate(policy, bob, 'model.allowed', 'gpt-5.4', 'gpt').allowed,
    ).toBe(true);
  });

  it('an external family is unavailable by catalog; a family default of unlimited opens it to everyone', () => {
    expect(
      isModelBlocked(policyWith([]), alice, 'claude-sonnet-5', 'claude'),
    ).toBe(true);
    const opened = policyWith([
      rule({ series: 'claude', defaultAccess: null }),
    ]);
    expect(isModelBlocked(opened, alice, 'claude-sonnet-5', 'claude')).toBe(
      false,
    );
    expect(isModelBlocked(opened, bob, 'claude-opus-5', 'claude')).toBe(false);
  });

  it('lists grant access over an unavailable default, with their own request terms', () => {
    const policy = policyWith([
      rule({
        series: 'claude',
        groups: [{ target: 'g-research', requests: 40 }],
        domains: [{ target: 'ocp.msf.org', requests: null }],
      }),
    ]);
    // alice via group (40/day on the family envelope), bob via domain (unlimited).
    expect(isModelBlocked(policy, alice, 'claude-sonnet-5', 'claude')).toBe(
      false,
    );
    expect(isModelBlocked(policy, bob, 'claude-sonnet-5', 'claude')).toBe(
      false,
    );
    const aliceCells = resolveModelCells(
      MODEL_REQUESTS,
      policy,
      alice,
      'claude-sonnet-5',
      'claude',
    );
    const family = aliceCells.find((c) => c.series === 'claude')!;
    expect(family.value).toBe(40);
    expect(family.source).toBe('group');
    expect(family.overrideId).toBe('model-access:family:claude|groups|40');
    expect(counterCellName(family)).toBe('family:claude.requests');
    const bobFamily = resolveModelCells(
      MODEL_REQUESTS,
      policy,
      bob,
      'claude-sonnet-5',
      'claude',
    ).find((c) => c.series === 'claude')!;
    expect(bobFamily.value).toBeNull();
    // Nobody on a list: still the catalog default.
    const carol: Principal = {
      userId: 'c',
      mail: 'carol@other.org',
      domain: 'other.org',
      attributes: [],
      groupIds: [],
    };
    expect(isModelBlocked(policy, carol, 'claude-sonnet-5', 'claude')).toBe(
      true,
    );
  });

  it('the block list beats a domain or group grant (user layer) and a model grant beats a family block for that person', () => {
    const policy = policyWith([
      rule({
        series: 'claude',
        defaultAccess: null,
        domains: [{ target: 'msf.org', requests: null }],
        deny: ['alice@msf.org'],
      }),
      rule({
        modelId: 'claude-sonnet-5',
        allow: [{ target: 'alice@msf.org', requests: 5 }],
      }),
    ]);
    // Family-wide block for alice…
    expect(isModelBlocked(policy, alice, 'claude-opus-5', 'claude')).toBe(true);
    // …except the one model she is explicitly allowed (model > family at the user layer).
    expect(isModelBlocked(policy, alice, 'claude-sonnet-5', 'claude')).toBe(
      false,
    );
    const gate = resolveModelGate(
      MODEL_ALLOWED,
      policy,
      alice,
      'claude-sonnet-5',
      'claude',
    );
    expect(gate.overrideId).toBe('model-access:model:claude-sonnet-5|allow|5');
    // Everyone else in the domain keeps the family grant.
    const dave: Principal = {
      userId: 'd',
      mail: 'dave@msf.org',
      domain: 'msf.org',
      attributes: [],
      groupIds: [],
    };
    expect(isModelBlocked(policy, dave, 'claude-opus-5', 'claude')).toBe(false);
  });

  it('block beats allow for one person at equal rank (more restrictive wins), should both ever be stored', () => {
    const policy = policyWith([
      rule({
        series: 'claude',
        allow: [{ target: 'alice@msf.org', requests: null }],
        deny: ['alice@msf.org'],
      }),
    ]);
    expect(isModelBlocked(policy, alice, 'claude-sonnet-5', 'claude')).toBe(
      true,
    );
  });

  it('a person-level family block still beats a model-level default (layer ranks before specificity)', () => {
    const policy = policyWith([
      rule({ modelId: 'claude-sonnet-5', defaultAccess: null }),
      rule({ series: 'claude', deny: ['alice@msf.org'] }),
    ]);
    expect(isModelBlocked(policy, alice, 'claude-sonnet-5', 'claude')).toBe(
      true,
    );
    expect(isModelBlocked(policy, bob, 'claude-sonnet-5', 'claude')).toBe(
      false,
    );
  });
});
