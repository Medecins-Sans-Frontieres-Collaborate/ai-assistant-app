import {
  ValueChange,
  diffPolicies,
  directionOf,
  everyoneValue,
  memberPrincipal,
  ruleEffect,
  summarizeChanges,
} from '@/lib/services/limits/policyChanges';
import { explainLimit, resolveLimit } from '@/lib/services/limits/resolver';
import { LimitValue, OverrideScope } from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { delegation, override, policy } from './policyFixtures';

import { getLimitDefinition } from '@/config/limits';
import { describe, expect, it } from 'vitest';

const MESSAGES = getLimitDefinition('chat.messagesPerDay')!;

/**
 * The admin views explain and diff policies through these functions, so
 * they must agree with enforcement exactly: the explanation is checked
 * against `resolveLimit` over many random policies, and the effect and diff
 * cases each include the side of the boundary that must NOT fire.
 */

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('explainLimit', () => {
  it('agrees with resolveLimit on 500 random policies', () => {
    const random = prng(7);
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)];
    const values: LimitValue[] = [0, 10, 50, 200, 500, null];
    const scopes: OverrideScope[] = ['user', 'domain', 'attribute', 'group'];
    const targetFor: Record<OverrideScope, string[]> = {
      user: ['ada@example.org', 'bo@example.org'],
      domain: ['example.org', 'other.org'],
      attribute: ['department:health', 'office:geneva'],
      group: ['11111111-1111-1111-1111-111111111111'],
    };
    const person: Principal = {
      userId: 'oid-1',
      mail: 'ada@example.org',
      domain: 'example.org',
      attributes: ['department:health'],
      groupIds: ['11111111-1111-1111-1111-111111111111'],
    };
    const del = delegation('del-000000000001', [
      { scope: 'domain', targets: ['example.org'] },
    ]);

    for (let round = 0; round < 500; round += 1) {
      const overrides = Array.from({ length: Math.floor(random() * 6) }, () => {
        const scope = pick(scopes);
        return override(
          scope,
          [pick(targetFor[scope])],
          [{ value: pick(values), ceiling: random() < 0.2 }],
          {
            priority: Math.floor(random() * 3),
            ...(random() < 0.25 ? { delegationId: del.id } : {}),
          },
        );
      });
      const subject = policy(
        random() < 0.7
          ? [{ value: pick(values), ceiling: random() < 0.3 }]
          : [],
        overrides,
        { delegations: [del] },
      );
      const explained = explainLimit(MESSAGES, subject, person);
      expect(explained.resolved).toEqual(
        resolveLimit(MESSAGES, subject, person),
      );
      // The winning layer is always one of the layers listed.
      expect(
        explained.layers.some((l) => l.source === explained.winnerSource),
      ).toBe(true);
    }
  });

  it('names the ceiling that pinned a cell, and lists layers least specific first', () => {
    const group = override('group', ['g-1'], [{ value: 500 }]);
    const subject = policy([{ value: 200, ceiling: true }], [group]);
    const why = explainLimit(
      MESSAGES,
      subject,
      memberPrincipal('group', 'g-1'),
    );
    expect(why.layers.map((l) => l.source)).toEqual([
      'catalog',
      'global',
      'group',
    ]);
    expect(why.winnerSource).toBe('group');
    expect(why.resolved.value).toBe(200);
    expect(why.ceiling).toMatchObject({ source: 'global', value: 200 });
  });
});

describe('ruleEffect', () => {
  it('applies: the audience gets the rule, and would otherwise get Everyone’s', () => {
    const group = override('group', ['g-1'], [{ value: 500 }]);
    const subject = policy([{ value: 200 }], [group]);
    const effect = ruleEffect(subject, group, group.entries[0])!;
    expect(effect.status).toBe('applies');
    expect(effect.withRule.resolved.value).toBe(500);
    expect(effect.otherwise.resolved.value).toBe(200);
  });

  it('held by a ceiling: a hard ceiling on Everyone stops a higher group value', () => {
    const group = override('group', ['g-1'], [{ value: 5000 }]);
    const subject = policy([{ value: 2000, ceiling: true }], [group]);
    const effect = ruleEffect(subject, group, group.entries[0])!;
    expect(effect.status).toBe('held-by-ceiling');
    expect(effect.withRule.resolved.value).toBe(2000);
  });

  it('a value under the ceiling is not held', () => {
    const group = override('group', ['g-1'], [{ value: 1000 }]);
    const subject = policy([{ value: 2000, ceiling: true }], [group]);
    expect(ruleEffect(subject, group, group.entries[0])!.status).toBe(
      'applies',
    );
  });

  it('outranked: a same-layer rule with higher priority decides', () => {
    const low = override('group', ['g-1'], [{ value: 500 }]);
    const high = override('group', ['g-1'], [{ value: 300 }], { priority: 5 });
    const subject = policy([], [low, high]);
    expect(ruleEffect(subject, low, low.entries[0])!.status).toBe('outranked');
    expect(ruleEffect(subject, high, high.entries[0])!.status).toBe('applies');
  });

  it('inert: a disabled rule, or a delegated rule whose delegation is off', () => {
    const off = override('group', ['g-1'], [{ value: 500 }], {
      enabled: false,
    });
    expect(ruleEffect(policy([], [off]), off, off.entries[0])!.status).toBe(
      'inert',
    );

    const del = delegation(
      'del-000000000002',
      [{ scope: 'domain', targets: ['ocp.org'] }],
      { enabled: false },
    );
    const scoped = override('domain', ['ocp.org'], [{ value: 500 }], {
      delegationId: del.id,
    });
    const subject = policy([], [scoped], { delegations: [del] });
    expect(ruleEffect(subject, scoped, scoped.entries[0])!.status).toBe(
      'inert',
    );
    // The same delegation switched on reaches its own jurisdiction.
    const on = policy([], [scoped], {
      delegations: [{ ...del, enabled: true }],
    });
    expect(ruleEffect(on, scoped, scoped.entries[0])!.status).toBe('applies');
  });
});

describe('diffPolicies', () => {
  const only = (changes: ReturnType<typeof diffPolicies>) =>
    changes.filter((c): c is ValueChange => c.type === 'value');

  it('reports nothing for identical policies', () => {
    const group = override('group', ['g-1'], [{ value: 500 }]);
    expect(
      diffPolicies(
        policy([{ value: 200 }], [group]),
        policy([{ value: 200 }], [group]),
      ),
    ).toEqual([]);
  });

  it('classifies a lower Everyone cap as stricter and a new unlimited rule as removing a cap', () => {
    const saved = policy([{ value: 100 }]);
    const group = override('group', ['g-1'], [{ value: null }]);
    const draft = policy([{ value: 50 }], [group]);
    const changes = only(diffPolicies(saved, draft));
    const everyone = changes.find((c) => c.audience.kind === 'everyone')!;
    expect(everyone.direction).toBe('stricter');
    expect(everyone).toMatchObject({ resolvedBefore: 100, resolvedAfter: 50 });
    const rule = changes.find((c) => c.audience.kind === 'rule')!;
    expect(rule.direction).toBe('looser');
    expect(rule.flags).toContain('removes-cap');
    expect(summarizeChanges(diffPolicies(saved, draft))).toMatchObject({
      stricter: 1,
      removesCap: 1,
      looser: 0,
    });
  });

  it('flags a rule held by a ceiling as having no effect, and not when it does have one', () => {
    const saved = policy([{ value: 2000, ceiling: true }]);
    const held = override('group', ['g-1'], [{ value: 5000 }]);
    const heldChange = only(
      diffPolicies(saved, policy(saved.defaults, [held])),
    )[0];
    expect(heldChange.direction).toBe('same');
    expect(heldChange.flags).toContain('no-effect');

    const real = override('group', ['g-1'], [{ value: 1000 }]);
    const realChange = only(
      diffPolicies(saved, policy(saved.defaults, [real])),
    )[0];
    expect(realChange.direction).toBe('stricter');
    expect(realChange.flags).not.toContain('no-effect');
  });

  it('flags a removed ceiling and a delegated loosening', () => {
    const del = delegation('del-000000000003', [
      { scope: 'domain', targets: ['ocp.org'] },
    ]);
    const scoped = override('domain', ['ocp.org'], [{ value: 100 }], {
      delegationId: del.id,
    });
    const saved = policy([{ value: 200, ceiling: true }], [scoped], {
      delegations: [del],
    });
    const raised = {
      ...scoped,
      entries: [{ ...scoped.entries[0], value: 150 }],
    };
    const draft = policy([{ value: 200 }], [raised], { delegations: [del] });
    const changes = only(diffPolicies(saved, draft));
    expect(
      changes.find((c) => c.audience.kind === 'everyone')!.flags,
    ).toContain('removes-ceiling');
    expect(changes.find((c) => c.audience.kind === 'rule')!.flags).toContain(
      'delegated-loosening',
    );
  });

  it('lists rule, setting and delegation changes after value changes', () => {
    const group = override('group', ['g-1'], [{ value: 500 }]);
    const saved = policy([], [group]);
    const draft = policy([], [{ ...group, targets: ['g-2'] }], {
      mode: 'enforce',
      delegations: [delegation('del-000000000004', [])],
    });
    const kinds = diffPolicies(saved, draft).map((c) =>
      c.type === 'rule' ? `rule:${c.change}` : c.type,
    );
    expect(kinds).toEqual(['rule:audience', 'setting', 'delegation']);
  });
});

describe('everyoneValue and directionOf', () => {
  it('ignores every exception', () => {
    const subject = policy(
      [{ value: 200 }],
      [override('domain', ['example.org'], [{ value: 10 }])],
    );
    expect(
      everyoneValue(subject, { limitKey: 'chat.messagesPerDay' })!.resolved
        .value,
    ).toBe(200);
  });

  it('orders off < a cap < unlimited', () => {
    expect(directionOf(false, 10)).toBe('looser');
    expect(directionOf(10, null)).toBe('looser');
    expect(directionOf(null, 0)).toBe('stricter');
    expect(directionOf(10, 10)).toBe('same');
  });
});
