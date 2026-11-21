import type { ModelAccessRule } from '@/lib/services/limits/types';

import {
  Audience,
  audienceCell,
  audienceColumns,
  audienceEntries,
  parseAudience,
  peopleCounts,
  reachOf,
  withAudienceTerms,
  withAudiencesTerms,
  withDefaultAccess,
} from '@/lib/utils/app/modelAccessGrid';

import { describe, expect, it } from 'vitest';

/** The grid is a second reading of the same rules; these pin that reading. */

function rule(partial: Partial<ModelAccessRule>): ModelAccessRule {
  return { groups: [], domains: [], allow: [], deny: [], ...partial };
}

const GROUP: Audience = { scope: 'group', target: 'g-pilot' };
const DOMAIN: Audience = { scope: 'domain', target: 'oca.msf.org' };
const PERSON: Audience = { scope: 'user', target: 'ana@msf.org' };
const FAMILY = { series: 'claude' };
const MODEL = { modelId: 'claude-opus' };

describe('parseAudience', () => {
  it('reads a mail as a person, a bare or @-prefixed domain as a domain, a GUID as a group', () => {
    expect(parseAudience(' Ana@MSF.org ')).toEqual(PERSON);
    expect(parseAudience('oca.msf.org')).toEqual(DOMAIN);
    expect(parseAudience('@OCA.msf.org')).toEqual(DOMAIN);
    expect(parseAudience('11111111-2222-3333-4444-55555555AAAA')).toEqual({
      scope: 'group',
      target: '11111111-2222-3333-4444-55555555aaaa',
    });
  });

  it('refuses text that is none of the three', () => {
    for (const text of ['', 'finance', 'ana@', 'ana@msf', 'a b@msf.org']) {
      expect(parseAudience(text)).toBeNull();
    }
  });
});

describe('audienceColumns', () => {
  it('lists each granted or blocked group then domain once, then empty added columns', () => {
    const rules = [
      rule({
        series: 'claude',
        domains: [{ target: 'oca.msf.org', requests: null }],
        denyGroups: ['g-contractors'],
      }),
      rule({
        modelId: 'claude-opus',
        groups: [{ target: 'g-pilot', requests: 20 }],
        domains: [{ target: 'OCA.msf.org', requests: 5 }],
        denyDomains: ['ext.org'],
      }),
    ];
    expect(
      audienceColumns(rules, [
        { scope: 'domain', target: 'new.org' },
        { scope: 'group', target: 'G-PILOT' },
        { scope: 'group', target: ' ' },
      ]),
    ).toEqual([
      { scope: 'group', target: 'g-contractors' },
      { scope: 'group', target: 'g-pilot' },
      { scope: 'domain', target: 'oca.msf.org' },
      { scope: 'domain', target: 'ext.org' },
      { scope: 'domain', target: 'new.org' },
    ]);
  });
});

describe('audienceCell', () => {
  const rules = [
    rule({
      series: 'claude',
      groups: [{ target: 'g-pilot', requests: 100 }],
      denyDomains: ['oca.msf.org'],
      deny: ['ana@msf.org'],
    }),
    rule({
      modelId: 'claude-opus',
      groups: [{ target: 'G-Pilot', requests: 20 }],
      domains: [{ target: 'oca.msf.org', requests: null }],
    }),
  ];

  it('shows a row’s own terms, a model’s inherited family terms, or nothing', () => {
    expect(audienceCell(rules, FAMILY, undefined, GROUP)).toEqual({
      kind: 'set',
      terms: 100,
    });
    expect(audienceCell(rules, MODEL, 'claude', GROUP)).toEqual({
      kind: 'set',
      terms: 20,
    });
    expect(
      audienceCell(rules, { modelId: 'claude-sonnet' }, 'claude', GROUP),
    ).toEqual({ kind: 'inherited', terms: 100 });
    expect(audienceCell(rules, FAMILY, undefined, PERSON)).toEqual({
      kind: 'set',
      terms: false,
    });
    expect(
      audienceCell(rules, FAMILY, undefined, {
        scope: 'domain',
        target: 'none.org',
      }),
    ).toEqual({ kind: 'empty' });
  });

  it('a family block wins over the model’s own grant, as the resolver decides', () => {
    expect(audienceCell(rules, MODEL, 'claude', DOMAIN)).toEqual({
      kind: 'inherited',
      terms: false,
    });
  });
});

describe('audienceEntries', () => {
  it('lists own groups, domains and people together, then family entries the model has none for', () => {
    const rules = [
      rule({
        series: 'claude',
        groups: [{ target: 'g-pilot', requests: 100 }],
        denyDomains: ['oca.msf.org'],
        allow: [{ target: 'zed@msf.org', requests: null }],
      }),
      rule({
        modelId: 'claude-opus',
        domains: [{ target: 'oca.msf.org', requests: 5 }],
        deny: ['ana@msf.org'],
      }),
    ];
    expect(audienceEntries(rules, MODEL, 'claude')).toEqual([
      // The family blocks this domain, so the model's grant does nothing.
      { audience: DOMAIN, terms: 5, origin: 'own', overruled: true },
      { audience: PERSON, terms: false, origin: 'own', overruled: false },
      { audience: GROUP, terms: 100, origin: 'family', overruled: false },
      {
        audience: { scope: 'user', target: 'zed@msf.org' },
        terms: null,
        origin: 'family',
        overruled: false,
      },
    ]);
    // A family row never shows inherited entries.
    expect(
      audienceEntries(rules, FAMILY, undefined).map((e) => e.origin),
    ).toEqual(['own', 'own', 'own']);
  });
});

describe('withAudienceTerms', () => {
  it('edits a group, a domain and a person the same way: grant, cap, block, remove', () => {
    for (const audience of [GROUP, DOMAIN, PERSON]) {
      const granted = withAudienceTerms([], FAMILY, audience, null);
      expect(audienceCell(granted, FAMILY, undefined, audience)).toEqual({
        kind: 'set',
        terms: null,
      });
      const capped = withAudienceTerms(granted, FAMILY, audience, 30);
      expect(audienceCell(capped, FAMILY, undefined, audience)).toEqual({
        kind: 'set',
        terms: 30,
      });
      const blocked = withAudienceTerms(capped, FAMILY, audience, false);
      expect(audienceCell(blocked, FAMILY, undefined, audience)).toEqual({
        kind: 'set',
        terms: false,
      });
      // One entry per audience: the block replaced the grant.
      expect(audienceEntries(blocked, FAMILY, undefined)).toHaveLength(1);
      const regranted = withAudienceTerms(blocked, FAMILY, audience, 7);
      expect(audienceEntries(regranted, FAMILY, undefined)).toEqual([
        { audience, terms: 7, origin: 'own', overruled: false },
      ]);
      // Removing the last thing a rule says removes the rule.
      expect(withAudienceTerms(regranted, FAMILY, audience, undefined)).toEqual(
        [],
      );
    }
  });

  it('stores each kind on its own lists and leaves the others alone', () => {
    const start = [
      rule({
        series: 'claude',
        defaultAccess: false,
        groups: [{ target: 'g-other', requests: 1 }],
      }),
    ];
    const next = withAudienceTerms(
      withAudienceTerms(start, FAMILY, DOMAIN, false),
      FAMILY,
      { scope: 'group', target: ' G-Pilot ' },
      50,
    );
    expect(next).toEqual([
      rule({
        series: 'claude',
        defaultAccess: false,
        groups: [
          { target: 'g-other', requests: 1 },
          { target: 'g-pilot', requests: 50 },
        ],
        denyDomains: ['oca.msf.org'],
      }),
    ]);
    // Unblocking the only blocked domain drops the optional list again.
    expect(
      withAudienceTerms(next, FAMILY, DOMAIN, undefined)[0],
    ).not.toHaveProperty('denyDomains');
  });
});

describe('withAudiencesTerms', () => {
  it('gives a mix of audiences the same terms on several rows at once', () => {
    const next = withAudiencesTerms(
      [rule({ modelId: 'claude-opus', deny: ['ana@msf.org'] })],
      [FAMILY, MODEL],
      [GROUP, DOMAIN, PERSON],
      25,
    );
    for (const dim of [FAMILY, MODEL]) {
      for (const audience of [GROUP, DOMAIN, PERSON]) {
        expect(audienceCell(next, dim, undefined, audience)).toEqual({
          kind: 'set',
          terms: 25,
        });
      }
    }
    // The person was blocked on the model: granting moved them off the list.
    expect(next.find((r) => r.modelId === 'claude-opus')?.deny).toEqual([]);
  });
});

describe('withDefaultAccess', () => {
  it('sets, changes and clears the everyone-else default', () => {
    const set = withDefaultAccess([], FAMILY, false);
    expect(set).toEqual([rule({ series: 'claude', defaultAccess: false })]);
    expect(withDefaultAccess(set, FAMILY, 10)[0].defaultAccess).toBe(10);
    expect(withDefaultAccess(set, FAMILY, undefined)).toEqual([]);
  });
});

describe('peopleCounts', () => {
  it('counts own and inherited people, allowed and blocked', () => {
    const rules = [
      rule({
        series: 'claude',
        allow: [{ target: 'a@msf.org', requests: null }],
        deny: ['b@msf.org', 'c@msf.org'],
      }),
      rule({
        modelId: 'claude-opus',
        allow: [{ target: 'd@msf.org', requests: 5 }],
        // The model's own entry for b replaces the family's in the list.
        deny: ['b@msf.org'],
      }),
    ];
    expect(peopleCounts(rules, MODEL, 'claude')).toEqual({
      allowed: 1,
      blocked: 1,
      inheritedAllowed: 1,
      inheritedBlocked: 1,
    });
  });
});

describe('reachOf', () => {
  it('sums up an open row by who is shut out, and a closed row by who is let in', () => {
    const open = [
      rule({
        series: 'gpt',
        defaultAccess: null,
        denyGroups: ['g-contractors'],
        denyDomains: ['ext.org'],
        deny: ['m@msf.org'],
        // A grant on an open row shuts nobody out.
        allow: [{ target: 'vip@msf.org', requests: null }],
      }),
    ];
    expect(reachOf(open, [], { series: 'gpt' }, undefined)).toEqual({
      kind: 'everyoneBut',
      groups: 1,
      domains: 1,
      people: 1,
    });
    expect(
      reachOf(
        [rule({ series: 'gpt', defaultAccess: null })],
        [],
        { series: 'gpt' },
        undefined,
      ),
    ).toEqual({ kind: 'everyone' });

    const closed = [
      rule({
        series: 'claude',
        defaultAccess: false,
        groups: [{ target: 'g-pilot', requests: null }],
        allow: [{ target: 'a@msf.org', requests: 5 }],
        deny: ['m@msf.org'],
      }),
    ];
    expect(reachOf(closed, [], FAMILY, undefined)).toEqual({
      kind: 'listed',
      groups: 1,
      domains: 0,
      people: 1,
    });
    expect(
      reachOf(
        [rule({ series: 'claude', defaultAccess: false })],
        [],
        FAMILY,
        undefined,
      ),
    ).toEqual({ kind: 'nobody' });
  });

  it('counts a family grant on its models, but not a model grant the family blocks', () => {
    const rules = [
      rule({
        series: 'claude',
        defaultAccess: false,
        groups: [{ target: 'g-pilot', requests: null }],
        denyDomains: ['oca.msf.org'],
      }),
      rule({
        modelId: 'claude-opus',
        domains: [{ target: 'oca.msf.org', requests: null }],
      }),
    ];
    expect(reachOf(rules, [], MODEL, 'claude')).toEqual({
      kind: 'listed',
      groups: 1,
      domains: 0,
      people: 0,
    });
  });
});
