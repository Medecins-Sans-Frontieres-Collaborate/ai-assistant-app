import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitOverride,
} from '@/lib/services/limits/types';

import {
  delegationOverlaps,
  hasUndecidable,
  isMailAnchored,
  liftableDefaults,
  mergeRelevantRules,
  narrowedOverrideCount,
  outOfScopeTargets,
  relevantRulesFor,
  summarizeJurisdiction,
  summarizeTargets,
  verdictForTarget,
  verdictsForTargets,
} from '@/components/Limits/jurisdiction';

import { describe, expect, it } from 'vitest';

const DOMAIN_OCP: JurisdictionPredicate = {
  scope: 'domain',
  targets: ['ocp.msf.org'],
};
const USER_ALICE: JurisdictionPredicate = {
  scope: 'user',
  targets: ['Alice@Paris.msf.org'],
};
const GROUP_G1: JurisdictionPredicate = {
  scope: 'group',
  targets: ['11111111-2222-3333-4444-555555555555'],
};
const ATTR_HEALTH: JurisdictionPredicate = {
  scope: 'attribute',
  targets: ['department:health'],
};

let counter = 0;
function delegation(
  jurisdiction: JurisdictionPredicate[],
  extra: Partial<LimitDelegation> = {},
): LimitDelegation {
  counter += 1;
  return {
    id: `del-${counter.toString(16).padStart(12, '0')}`,
    label: `Delegation ${counter}`,
    enabled: true,
    admins: [],
    jurisdiction,
    maxOverrides: 25,
    createdBy: 'a@x.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'a@x.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function override(
  scope: LimitOverride['scope'],
  targets: string[],
  extra: Partial<LimitOverride> = {},
): LimitOverride {
  counter += 1;
  return {
    id: `lim-${counter.toString(16).padStart(12, '0')}`,
    label: `Override ${counter}`,
    enabled: true,
    scope,
    targets,
    priority: 0,
    entries: [],
    createdBy: 'a@x.org',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'a@x.org',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('summarizeJurisdiction', () => {
  it('buckets, lowercases and dedupes targets', () => {
    const summary = summarizeJurisdiction([
      DOMAIN_OCP,
      { scope: 'domain', targets: ['OCP.MSF.ORG', ' paris.msf.org '] },
      USER_ALICE,
      GROUP_G1,
      ATTR_HEALTH,
    ]);
    expect(summary).toMatchObject({
      domains: ['ocp.msf.org', 'paris.msf.org'],
      users: ['alice@paris.msf.org'],
      groups: ['11111111-2222-3333-4444-555555555555'],
      attributes: ['department:health'],
    });
  });

  it('isMailAnchored is true only with a domain or user target', () => {
    expect(isMailAnchored([DOMAIN_OCP])).toBe(true);
    expect(isMailAnchored([USER_ALICE])).toBe(true);
    expect(isMailAnchored([GROUP_G1, ATTR_HEALTH])).toBe(false);
    // A predicate with no targets anchors nothing.
    expect(isMailAnchored([{ scope: 'domain', targets: [] }])).toBe(false);
  });
});

/** The §4 table, row by row. */
describe('verdictForTarget', () => {
  describe('user target', () => {
    it('is in scope when its domain is a jurisdiction domain', () => {
      expect(verdictForTarget('user', 'Bob@OCP.msf.org', [DOMAIN_OCP])).toEqual(
        {
          target: 'Bob@OCP.msf.org',
          status: 'in-scope',
          reason: 'domain-match',
        },
      );
    });

    it('is in scope when the mail is a listed jurisdiction user', () => {
      expect(
        verdictForTarget('user', 'alice@paris.msf.org', [USER_ALICE]),
      ).toMatchObject({ status: 'in-scope', reason: 'user-match' });
    });

    it('is provably out of scope against a domain/user-anchored jurisdiction', () => {
      expect(
        verdictForTarget('user', 'bob@paris.msf.org', [DOMAIN_OCP]),
      ).toMatchObject({ status: 'out-of-scope', reason: 'not-in-domains' });
      expect(
        verdictForTarget('user', 'bob@paris.msf.org', [USER_ALICE]),
      ).toMatchObject({ status: 'out-of-scope', reason: 'not-in-users' });
    });

    it('is undecidable when the jurisdiction has a group or attribute predicate', () => {
      expect(
        verdictForTarget('user', 'bob@paris.msf.org', [DOMAIN_OCP, GROUP_G1]),
      ).toMatchObject({
        status: 'undecidable',
        reason: 'group-or-attribute-jurisdiction',
      });
      expect(
        verdictForTarget('user', 'bob@paris.msf.org', [ATTR_HEALTH]),
      ).toMatchObject({ status: 'undecidable' });
    });

    it('still decides in-scope positively under a mixed jurisdiction', () => {
      // Membership is unknown, but the domain already puts them inside.
      expect(
        verdictForTarget('user', 'bob@ocp.msf.org', [DOMAIN_OCP, GROUP_G1]),
      ).toMatchObject({ status: 'in-scope', reason: 'domain-match' });
    });
  });

  describe('domain target', () => {
    it('is in scope when listed, out of scope otherwise', () => {
      expect(
        verdictForTarget('domain', 'OCP.MSF.ORG', [DOMAIN_OCP]),
      ).toMatchObject({ status: 'in-scope', reason: 'domain-match' });
      expect(
        verdictForTarget('domain', 'paris.msf.org', [DOMAIN_OCP]),
      ).toMatchObject({ status: 'out-of-scope', reason: 'not-in-domains' });
    });

    it('is "not fully inside" (out of scope) for a user-only jurisdiction', () => {
      // Reason `not-in-users` is the server's deliberate answer: it tells the
      // client the jurisdiction had no domain predicate at all (design §4).
      expect(
        verdictForTarget('domain', 'paris.msf.org', [USER_ALICE]),
      ).toMatchObject({ status: 'out-of-scope', reason: 'not-in-users' });
    });

    it('is undecidable under a group/attribute jurisdiction', () => {
      expect(
        verdictForTarget('domain', 'paris.msf.org', [GROUP_G1]),
      ).toMatchObject({
        status: 'undecidable',
        reason: 'group-or-attribute-jurisdiction',
      });
    });
  });

  it('group and attribute targets are cross-axis (allow + warn) unless the jurisdiction names them', () => {
    expect(
      verdictForTarget('group', GROUP_G1.targets[0], [DOMAIN_OCP]),
    ).toMatchObject({ status: 'undecidable', reason: 'cross-axis' });
    // Design §4: "in jurisdiction if the id ∈ jurisdiction groups" — the same
    // answer the server gives (client and server share one implementation).
    expect(
      verdictForTarget('group', GROUP_G1.targets[0], [GROUP_G1]),
    ).toMatchObject({
      status: 'in-scope',
      reason: 'group-or-attribute-jurisdiction',
    });
    expect(
      verdictForTarget('attribute', 'department:health', [DOMAIN_OCP]),
    ).toMatchObject({ status: 'undecidable', reason: 'cross-axis' });
  });

  it('outOfScopeTargets / hasUndecidable summarise a verdict list', () => {
    const verdicts = verdictsForTargets(
      'user',
      ['a@ocp.msf.org', 'b@paris.msf.org', 'c@geneva.msf.org'],
      [DOMAIN_OCP],
    );
    expect(outOfScopeTargets(verdicts)).toEqual([
      'b@paris.msf.org',
      'c@geneva.msf.org',
    ]);
    expect(hasUndecidable(verdicts)).toBe(false);
    expect(
      hasUndecidable(verdictsForTargets('attribute', ['x:y'], [DOMAIN_OCP])),
    ).toBe(true);
  });
});

describe('narrowedOverrideCount', () => {
  it('counts overrides with at least one provably-outside target', () => {
    const owned = [
      override('user', ['a@ocp.msf.org']),
      override('user', ['a@ocp.msf.org', 'b@paris.msf.org']),
      override('domain', ['paris.msf.org']),
      override('attribute', ['department:health']), // undecidable, not counted
    ];
    expect(narrowedOverrideCount([DOMAIN_OCP], owned)).toBe(2);
    // Widening the jurisdiction to Paris rescues both.
    expect(
      narrowedOverrideCount(
        [DOMAIN_OCP, { scope: 'domain', targets: ['paris.msf.org'] }],
        owned,
      ),
    ).toBe(0);
  });
});

describe('liftableDefaults', () => {
  it('lists configured defaults without a ceiling that can still be raised', () => {
    const entries = liftableDefaults([
      { limitKey: 'chat.messagesPerDay', value: 100, ceiling: false },
      { limitKey: 'feature.webSearch.enabled', value: false, ceiling: false },
      { limitKey: 'chat.tokensPerDay', value: 1000, ceiling: true },
      { limitKey: 'chat.tokensPerMonth', value: null, ceiling: false },
      { limitKey: 'feature.mcp.enabled', value: true, ceiling: false },
    ]);
    expect(entries.map((e) => e.limitKey)).toEqual([
      'chat.messagesPerDay',
      'feature.webSearch.enabled',
    ]);
  });
});

describe('delegationOverlaps', () => {
  it('reports a shared domain once per pair and scope', () => {
    const a = delegation([DOMAIN_OCP]);
    const b = delegation([{ scope: 'domain', targets: ['OCP.MSF.ORG'] }]);
    expect(delegationOverlaps([a, b])).toEqual([
      { a: a.id, b: b.id, scope: 'domain', shared: ['ocp.msf.org'] },
    ]);
  });

  it('reports a user listed in one delegation whose domain the other holds', () => {
    const a = delegation([DOMAIN_OCP]);
    const b = delegation([{ scope: 'user', targets: ['Carol@ocp.msf.org'] }]);
    expect(delegationOverlaps([a, b])).toEqual([
      { a: a.id, b: b.id, scope: 'user', shared: ['carol@ocp.msf.org'] },
    ]);
    // Symmetric: order of the two delegations does not matter.
    expect(delegationOverlaps([b, a])).toEqual([
      { a: b.id, b: a.id, scope: 'user', shared: ['carol@ocp.msf.org'] },
    ]);
  });

  it('never reports group-vs-domain (membership is opaque)', () => {
    const a = delegation([DOMAIN_OCP]);
    const b = delegation([GROUP_G1]);
    expect(delegationOverlaps([a, b])).toEqual([]);
  });

  it('reports identical group ids and identical attributes', () => {
    const a = delegation([GROUP_G1, ATTR_HEALTH]);
    const b = delegation([
      GROUP_G1,
      { scope: 'attribute', targets: ['department:HEALTH'] },
    ]);
    expect(delegationOverlaps([a, b])).toEqual([
      { a: a.id, b: b.id, scope: 'group', shared: GROUP_G1.targets },
      { a: a.id, b: b.id, scope: 'attribute', shared: ['department:health'] },
    ]);
  });

  it('is empty for disjoint jurisdictions', () => {
    expect(
      delegationOverlaps([
        delegation([DOMAIN_OCP]),
        delegation([{ scope: 'domain', targets: ['paris.msf.org'] }]),
      ]),
    ).toEqual([]);
  });
});

describe('relevantRulesFor', () => {
  it('finds same-scope, user-in-domain and domain-contains-user matches, excluding self', () => {
    const self = override('user', ['dave@ocp.msf.org']);
    const domainRule = override('domain', ['ocp.msf.org']);
    const otherUser = override('user', ['dave@ocp.msf.org'], {
      delegationId: 'del-000000000001',
    });
    const unrelated = override('domain', ['paris.msf.org']);
    const del = delegation([DOMAIN_OCP]);

    const rules = relevantRulesFor(
      'user',
      ['dave@ocp.msf.org'],
      {
        overrides: [self, domainRule, otherUser, unrelated],
        delegations: [del],
      },
      self.id,
    );
    expect(rules.map((r) => r.id)).toEqual([
      domainRule.id,
      otherUser.id,
      del.id,
    ]);
    expect(rules[1]).toMatchObject({
      kind: 'override',
      tier: 'scoped',
      delegationId: 'del-000000000001',
      matched: ['dave@ocp.msf.org'],
    });
    expect(rules[2]).toMatchObject({ kind: 'delegation', scope: 'domain' });

    // A domain query catches user rules inside that domain.
    const forDomain = relevantRulesFor('domain', ['ocp.msf.org'], {
      overrides: [self],
      delegations: [],
    });
    expect(forDomain.map((r) => r.id)).toEqual([self.id]);
  });

  it('matches groups and attributes by equality only', () => {
    const groupRule = override('group', GROUP_G1.targets);
    expect(
      relevantRulesFor('domain', ['ocp.msf.org'], {
        overrides: [groupRule],
        delegations: [delegation([GROUP_G1])],
      }),
    ).toEqual([]);
    expect(
      relevantRulesFor('group', GROUP_G1.targets, {
        overrides: [groupRule],
        delegations: [],
      }).map((r) => r.id),
    ).toEqual([groupRule.id]);
  });
});

/**
 * Contract: the Delegations tab queries relevant rules ONCE PER PREDICATE of a
 * jurisdiction and concatenates. A rule that meets two predicates (a domain
 * plus a user inside it) must still be listed once — RelevantRulesPopover
 * keys rows on `${kind}-${id}` and counts them in its aria-label — with the
 * `matched` targets of both hits merged.
 */
describe('mergeRelevantRules', () => {
  it('collapses the per-predicate duplicates of a mixed jurisdiction to one row each (2 unique of 4)', () => {
    const self = delegation([
      DOMAIN_OCP,
      { scope: 'user', targets: ['alice@ocp.msf.org'] },
    ]);
    const aliceCap = override('user', ['alice@ocp.msf.org']);
    const otherDelegation = delegation([DOMAIN_OCP]);
    const pool = {
      overrides: [aliceCap],
      delegations: [self, otherDelegation],
    };

    // Exactly what DelegationsTab does before merging.
    const perPredicate = self.jurisdiction.flatMap((predicate) =>
      relevantRulesFor(predicate.scope, predicate.targets, pool, self.id),
    );
    expect(perPredicate.map((r) => `${r.kind}-${r.id}`)).toEqual([
      `override-${aliceCap.id}`,
      `delegation-${otherDelegation.id}`,
      `override-${aliceCap.id}`,
      `delegation-${otherDelegation.id}`,
    ]);

    const merged = mergeRelevantRules(perPredicate);
    expect(merged.map((r) => `${r.kind}-${r.id}`)).toEqual([
      `override-${aliceCap.id}`,
      `delegation-${otherDelegation.id}`,
    ]);
    // Both hits' targets survive, deduped: the domain query matched the user
    // rule by its domain, the user query matched it by mail.
    expect(merged[0].matched).toEqual(['ocp.msf.org', 'alice@ocp.msf.org']);
    expect(merged[1].matched).toEqual(['ocp.msf.org', 'alice@ocp.msf.org']);
  });

  it('keeps an override and a delegation with the same id apart, and leaves inputs untouched', () => {
    const a = override('user', ['alice@ocp.msf.org'], { id: 'shared-id' });
    const rules = relevantRulesFor('user', ['alice@ocp.msf.org'], {
      overrides: [a],
      delegations: [delegation([DOMAIN_OCP], { id: 'shared-id' })],
    });
    expect(rules).toHaveLength(2);
    const merged = mergeRelevantRules([...rules, ...rules]);
    expect(merged.map((r) => r.kind)).toEqual(['override', 'delegation']);
    expect(rules[0].matched).toEqual(['alice@ocp.msf.org']);
    expect(mergeRelevantRules([])).toEqual([]);
  });
});

describe('summarizeTargets', () => {
  it('truncates to the first three and counts the rest', () => {
    expect(summarizeTargets(['a', 'b', 'c', 'd', 'e'])).toEqual({
      shown: ['a', 'b', 'c'],
      more: 2,
    });
    expect(summarizeTargets(['a'])).toEqual({ shown: ['a'], more: 0 });
  });
});
