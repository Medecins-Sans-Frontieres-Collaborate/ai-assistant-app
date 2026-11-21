import type { ModelAccessRule } from '@/lib/services/limits/types';

import {
  audienceCell,
  audienceColumns,
  peopleLists,
  reachOf,
  withAudienceGrant,
  withDefaultAccess,
} from '@/lib/utils/app/modelAccessGrid';

import { describe, expect, it } from 'vitest';

/** The grid is a second reading of the same rules; these pin that reading. */

function rule(partial: Partial<ModelAccessRule>): ModelAccessRule {
  return { groups: [], domains: [], allow: [], deny: [], ...partial };
}

const GROUP = { scope: 'group' as const, target: 'g-pilot' };
const DOMAIN = { scope: 'domain' as const, target: 'oca.msf.org' };

describe('audienceColumns', () => {
  it('lists each granted group then domain once, then empty added columns', () => {
    const rules = [
      rule({
        series: 'claude',
        domains: [{ target: 'oca.msf.org', requests: null }],
      }),
      rule({
        modelId: 'claude-opus',
        groups: [{ target: 'g-pilot', requests: 20 }],
        domains: [{ target: 'OCA.msf.org', requests: 5 }],
      }),
    ];
    expect(
      audienceColumns(rules, [
        { scope: 'domain', target: 'new.org' },
        { scope: 'group', target: 'G-PILOT' },
        { scope: 'group', target: ' ' },
      ]),
    ).toEqual([
      { scope: 'group', target: 'g-pilot' },
      { scope: 'domain', target: 'oca.msf.org' },
      { scope: 'domain', target: 'new.org' },
    ]);
  });
});

describe('audienceCell', () => {
  const rules = [
    rule({ series: 'claude', groups: [{ target: 'g-pilot', requests: 100 }] }),
    rule({
      modelId: 'claude-opus',
      groups: [{ target: 'G-Pilot', requests: 20 }],
    }),
  ];

  it('shows a row’s own grant, a model’s inherited family grant, or nothing', () => {
    expect(audienceCell(rules, { series: 'claude' }, undefined, GROUP)).toEqual(
      {
        kind: 'set',
        requests: 100,
      },
    );
    expect(
      audienceCell(rules, { modelId: 'claude-opus' }, 'claude', GROUP),
    ).toEqual({ kind: 'set', requests: 20 });
    expect(
      audienceCell(rules, { modelId: 'claude-sonnet' }, 'claude', GROUP),
    ).toEqual({ kind: 'inherited', requests: 100 });
    expect(
      audienceCell(rules, { modelId: 'claude-sonnet' }, 'claude', DOMAIN),
    ).toEqual({ kind: 'empty' });
    // A family never inherits from its models.
    expect(audienceCell(rules, { series: 'gpt' }, undefined, GROUP)).toEqual({
      kind: 'empty',
    });
  });
});

describe('withAudienceGrant and withDefaultAccess', () => {
  it('adds, changes and removes a grant, dropping a rule left empty', () => {
    const added = withAudienceGrant([], { series: 'claude' }, GROUP, null);
    expect(added).toEqual([
      rule({
        series: 'claude',
        groups: [{ target: 'g-pilot', requests: null }],
      }),
    ]);
    const changed = withAudienceGrant(added, { series: 'claude' }, GROUP, 40);
    expect(changed[0].groups).toEqual([{ target: 'g-pilot', requests: 40 }]);
    expect(
      withAudienceGrant(changed, { series: 'claude' }, GROUP, undefined),
    ).toEqual([]);
  });

  it('sets the default and removes it on inherit, keeping the lists', () => {
    const base = [rule({ series: 'claude', deny: ['x@a.org'] })];
    const off = withDefaultAccess(base, { series: 'claude' }, false);
    expect(off[0]).toMatchObject({ defaultAccess: false, deny: ['x@a.org'] });
    const back = withDefaultAccess(off, { series: 'claude' }, undefined);
    expect(back[0]).not.toHaveProperty('defaultAccess');
    expect(back[0].deny).toEqual(['x@a.org']);
    // Unlimited (null) is a value, not "unset".
    expect(
      withDefaultAccess([], { modelId: 'm' }, null)[0].defaultAccess,
    ).toBeNull();
  });
});

describe('peopleLists and reachOf', () => {
  const rules = [
    rule({
      series: 'gpt-5',
      defaultAccess: 500,
      deny: ['blocked@a.org'],
    }),
    rule({
      series: 'claude',
      defaultAccess: false,
      groups: [{ target: 'g-pilot', requests: 100 }],
      allow: [{ target: 'p@a.org', requests: null }],
    }),
    rule({ series: 'closed', defaultAccess: false }),
    rule({
      modelId: 'claude-opus',
      allow: [{ target: 'q@a.org', requests: 5 }],
    }),
  ];

  it('counts a model’s own lists apart from what its family adds', () => {
    expect(peopleLists(rules, { modelId: 'claude-opus' }, 'claude')).toEqual({
      allow: 1,
      deny: 0,
      inheritedAllow: 1,
      inheritedDeny: 0,
    });
  });

  it('summarises who can use a row on both sides of the default', () => {
    expect(reachOf(rules, [], { series: 'gpt-5' }, undefined)).toEqual({
      kind: 'everyoneBut',
      blocked: 1,
    });
    expect(reachOf(rules, [], { modelId: 'gpt-5-mini' }, 'gpt-5')).toEqual({
      kind: 'everyoneBut',
      blocked: 1,
    });
    expect(reachOf(rules, [], { modelId: 'claude-opus' }, 'claude')).toEqual({
      kind: 'listed',
      groups: 1,
      domains: 0,
      people: 2,
    });
    expect(reachOf(rules, [], { series: 'closed' }, undefined)).toEqual({
      kind: 'nobody',
    });
    expect(
      reachOf(
        [rule({ series: 'open', defaultAccess: null })],
        [],
        { series: 'open' },
        undefined,
      ),
    ).toEqual({ kind: 'everyone' });
  });
});
