/**
 * Save-time verdicts for scoped overrides (design §4 as amended): every row of
 * the decidability table, the preview gate (§6c), the GET-time flags (§6b/§8)
 * and the `raises=<n>` audit count (§7). These are UX — containment itself is
 * pinned in delegations.test.ts — but a wrong verdict here either refuses a
 * legitimate save or stores a trap, so each rule gets its own assertion.
 */
import {
  canPreviewMail,
  countRaises,
  judgeTargets,
  jurisdictionWarnings,
  outOfScopeTargets,
  overrideFlags,
  summarizeJurisdiction,
} from '@/lib/services/limits/scopedVerdicts';
import {
  JurisdictionPredicate,
  LimitsPolicy,
  LimitsPolicySchema,
} from '@/lib/services/limits/types';

import { describe, expect, it } from 'vitest';

const GROUP_A = '00000000-0000-0000-0000-00000000000a';

const DOMAIN_ONLY: JurisdictionPredicate[] = [
  { scope: 'domain', targets: ['ocp.msf.org', 'Paris.MSF.org'] },
];
const USER_ONLY: JurisdictionPredicate[] = [
  { scope: 'user', targets: ['Alice@Other.org'] },
];
const GROUP_ONLY: JurisdictionPredicate[] = [
  { scope: 'group', targets: [GROUP_A] },
];
const MIXED: JurisdictionPredicate[] = [...DOMAIN_ONLY, ...GROUP_ONLY];

function policyWith(input: Partial<LimitsPolicy>): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  });
}

describe('summarizeJurisdiction', () => {
  it('lowercases, trims and dedupes per bucket and reports anchoring', () => {
    const summary = summarizeJurisdiction([
      { scope: 'domain', targets: [' OCP.msf.org ', 'ocp.msf.org'] },
      { scope: 'user', targets: ['Alice@x.org'] },
    ]);
    expect(summary.domains).toEqual(['ocp.msf.org']);
    expect(summary.users).toEqual(['alice@x.org']);
    expect(summary.anchored).toBe(true);
    expect(summary.hasOpaque).toBe(false);
  });

  it('flags a group/attribute predicate as opaque', () => {
    expect(summarizeJurisdiction(GROUP_ONLY)).toMatchObject({
      hasOpaque: true,
      anchored: false,
    });
    expect(summarizeJurisdiction(MIXED)).toMatchObject({
      hasOpaque: true,
      anchored: true,
    });
  });
});

describe('judgeTargets — user targets', () => {
  it('is in-scope by domain match (case-insensitive)', () => {
    expect(judgeTargets(DOMAIN_ONLY, 'user', ['Bob@OCP.msf.org'])).toEqual([
      { target: 'Bob@OCP.msf.org', status: 'in-scope', reason: 'domain-match' },
    ]);
  });

  it('is in-scope by listed user', () => {
    expect(judgeTargets(USER_ONLY, 'user', ['alice@other.org'])).toEqual([
      { target: 'alice@other.org', status: 'in-scope', reason: 'user-match' },
    ]);
  });

  it('is PROVABLY outside a domain-anchored jurisdiction with no opaque predicate', () => {
    expect(judgeTargets(DOMAIN_ONLY, 'user', ['eve@elsewhere.org'])).toEqual([
      {
        target: 'eve@elsewhere.org',
        status: 'out-of-scope',
        reason: 'not-in-domains',
      },
    ]);
    expect(judgeTargets(USER_ONLY, 'user', ['eve@elsewhere.org'])).toEqual([
      {
        target: 'eve@elsewhere.org',
        status: 'out-of-scope',
        reason: 'not-in-users',
      },
    ]);
  });

  it('is UNDECIDABLE (allow + warn) when the jurisdiction has any group/attribute predicate', () => {
    // Amended §4: the person may be inside via the group at runtime, so a
    // static check must not refuse. Containment still confines the record.
    expect(judgeTargets(GROUP_ONLY, 'user', ['eve@elsewhere.org'])).toEqual([
      {
        target: 'eve@elsewhere.org',
        status: 'undecidable',
        reason: 'group-or-attribute-jurisdiction',
      },
    ]);
    expect(judgeTargets(MIXED, 'user', ['eve@elsewhere.org'])[0].status).toBe(
      'undecidable',
    );
    // ...but a domain match inside a mixed jurisdiction is still decided.
    expect(judgeTargets(MIXED, 'user', ['bob@ocp.msf.org'])[0].status).toBe(
      'in-scope',
    );
  });
});

describe('judgeTargets — domain targets', () => {
  it('is in-scope when the domain is listed', () => {
    expect(
      judgeTargets(DOMAIN_ONLY, 'domain', ['PARIS.msf.org'])[0],
    ).toMatchObject({ status: 'in-scope', reason: 'domain-match' });
  });

  it('is outside when not listed and nothing opaque could admit it', () => {
    expect(
      judgeTargets(DOMAIN_ONLY, 'domain', ['elsewhere.org'])[0],
    ).toMatchObject({ status: 'out-of-scope', reason: 'not-in-domains' });
  });

  it('is "not fully inside" (rejected, reason not-in-users) under a user-only jurisdiction', () => {
    expect(judgeTargets(USER_ONLY, 'domain', ['other.org'])[0]).toMatchObject({
      status: 'out-of-scope',
      reason: 'not-in-users',
    });
  });

  it('is undecidable under a group-anchored jurisdiction', () => {
    expect(judgeTargets(MIXED, 'domain', ['elsewhere.org'])[0]).toMatchObject({
      status: 'undecidable',
      reason: 'group-or-attribute-jurisdiction',
    });
  });
});

describe('judgeTargets — group and attribute targets', () => {
  it('a group listed in the jurisdiction is in-scope', () => {
    expect(
      judgeTargets(GROUP_ONLY, 'group', [GROUP_A.toUpperCase()])[0],
    ).toMatchObject({
      status: 'in-scope',
      reason: 'group-or-attribute-jurisdiction',
    });
  });

  it('any other group is cross-axis: allowed with a warning, never rejected', () => {
    expect(
      judgeTargets(DOMAIN_ONLY, 'group', ['some-other-group'])[0],
    ).toMatchObject({ status: 'undecidable', reason: 'cross-axis' });
  });

  it('attributes are always cross-axis unless the jurisdiction names the same value', () => {
    expect(
      judgeTargets(DOMAIN_ONLY, 'attribute', ['department:health'])[0],
    ).toMatchObject({ status: 'undecidable', reason: 'cross-axis' });
    expect(
      judgeTargets(
        [{ scope: 'attribute', targets: ['department:health'] }],
        'attribute',
        ['Department:Health'],
      )[0].status,
    ).toBe('in-scope');
  });
});

describe('outOfScopeTargets', () => {
  it('names exactly the provably-outside targets, in order', () => {
    const verdicts = judgeTargets(DOMAIN_ONLY, 'user', [
      'a@ocp.msf.org',
      'b@x.org',
      'c@y.org',
    ]);
    expect(outOfScopeTargets(verdicts)).toEqual(['b@x.org', 'c@y.org']);
  });
});

describe('jurisdictionWarnings / overrideFlags', () => {
  it('warns when no domain or user predicate anchors the jurisdiction (§8)', () => {
    expect(jurisdictionWarnings({ jurisdiction: GROUP_ONLY })).toEqual([
      'no-domain-or-user-anchor',
    ]);
    expect(jurisdictionWarnings({ jurisdiction: MIXED })).toEqual([]);
    expect(jurisdictionWarnings({ jurisdiction: [] })).toEqual([
      'no-domain-or-user-anchor',
    ]);
  });

  it('flags a narrowed override whose targets are now provably outside', () => {
    expect(
      overrideFlags(
        { scope: 'user', targets: ['a@ocp.msf.org', 'b@x.org'] },
        { enabled: true, jurisdiction: DOMAIN_ONLY },
      ),
    ).toEqual(['out-of-scope-targets']);
  });

  it('flags a disabled or missing delegation — inert, never global', () => {
    expect(
      overrideFlags(
        { scope: 'user', targets: ['a@ocp.msf.org'] },
        { enabled: false, jurisdiction: DOMAIN_ONLY },
      ),
    ).toEqual(['delegation-disabled']);
    expect(
      overrideFlags({ scope: 'user', targets: ['a@ocp.msf.org'] }, undefined),
    ).toEqual(['delegation-disabled']);
  });

  it('is empty for an in-scope override under an enabled delegation', () => {
    expect(
      overrideFlags(
        { scope: 'domain', targets: ['ocp.msf.org'] },
        { enabled: true, jurisdiction: DOMAIN_ONLY },
      ),
    ).toEqual([]);
  });
});

describe('canPreviewMail (§6c)', () => {
  it('allows a mail in a delegation domain or listed as a user, across delegations', () => {
    const delegations = [
      { jurisdiction: DOMAIN_ONLY },
      { jurisdiction: USER_ONLY },
    ];
    expect(canPreviewMail(delegations, 'Bob@ocp.msf.org')).toBe('allowed');
    expect(canPreviewMail(delegations, 'alice@other.org')).toBe('allowed');
  });

  it('is provably outside when every predicate is static and none matches', () => {
    expect(canPreviewMail([{ jurisdiction: DOMAIN_ONLY }], 'eve@x.org')).toBe(
      'outside',
    );
  });

  it('is undecidable when a group/attribute predicate could admit the mail', () => {
    expect(canPreviewMail([{ jurisdiction: GROUP_ONLY }], 'eve@x.org')).toBe(
      'undecidable',
    );
    expect(canPreviewMail([{ jurisdiction: MIXED }], 'eve@x.org')).toBe(
      'undecidable',
    );
  });

  it('is outside for no delegations at all', () => {
    expect(canPreviewMail([], 'eve@x.org')).toBe('outside');
  });
});

describe('countRaises (§7 audit)', () => {
  const policy = policyWith({
    defaults: [
      { limitKey: 'chat.messagesPerDay', value: 100 },
      { limitKey: 'feature.mcp.enabled', value: false },
    ],
    overrides: [
      {
        id: 'lim-000000000001',
        scope: 'domain',
        targets: ['ocp.msf.org'],
        entries: [{ limitKey: 'chat.messagesPerDay', value: 50 }],
        createdBy: 'a',
        createdAt: 'b',
        updatedBy: 'a',
        updatedAt: 'b',
      },
      {
        // A SCOPED record must not count as part of the global tier.
        id: 'lim-000000000002',
        scope: 'domain',
        targets: ['ocp.msf.org'],
        delegationId: 'del-000000000001',
        entries: [{ limitKey: 'chat.messagesPerDay', value: 1000 }],
        createdBy: 'a',
        createdAt: 'b',
        updatedBy: 'a',
        updatedAt: 'b',
      },
    ],
  });

  it('counts entries less restrictive than the global tier for the targeted people', () => {
    expect(
      countRaises(policy, {
        scope: 'user',
        targets: ['bob@ocp.msf.org'],
        entries: [
          // Global tier gives 50 (domain override) → 200 is a raise.
          { limitKey: 'chat.messagesPerDay', value: 200, ceiling: false },
          // null = unlimited → a raise.
          { limitKey: 'chat.tokensPerDay', value: null, ceiling: false },
          // Un-gating a blocked feature is a raise.
          { limitKey: 'feature.mcp.enabled', value: true, ceiling: false },
          // 40 < 50 → not a raise.
          { limitKey: 'chat.messagesPerDay', value: 40, ceiling: false },
        ],
      }),
    ).toBe(2); // 200 and true; null equals the catalog default (not a raise), 40 lowers
  });

  it('compares against the global tier ONLY (scoped records excluded) and per-target', () => {
    // Outside ocp the domain override does not apply: 100 is the base.
    expect(
      countRaises(policy, {
        scope: 'user',
        targets: ['eve@paris.msf.org'],
        entries: [
          { limitKey: 'chat.messagesPerDay', value: 80, ceiling: false },
        ],
      }),
    ).toBe(0);
    // Inside ocp the base is 50 — the scoped 1000 record is ignored.
    expect(
      countRaises(policy, {
        scope: 'domain',
        targets: ['ocp.msf.org'],
        entries: [
          { limitKey: 'chat.messagesPerDay', value: 80, ceiling: false },
        ],
      }),
    ).toBe(1);
  });

  it('is zero for no targets or no entries', () => {
    expect(
      countRaises(policy, { scope: 'user', targets: [], entries: [] }),
    ).toBe(0);
  });
});

describe('summarizeJurisdiction — empty predicates', () => {
  it('a predicate with no targets neither anchors nor makes the jurisdiction opaque', () => {
    expect(
      summarizeJurisdiction([{ scope: 'domain', targets: [] }]),
    ).toMatchObject({ anchored: false, hasOpaque: false });
    expect(
      summarizeJurisdiction([{ scope: 'group', targets: [] }]),
    ).toMatchObject({ anchored: false, hasOpaque: false });
  });
});
