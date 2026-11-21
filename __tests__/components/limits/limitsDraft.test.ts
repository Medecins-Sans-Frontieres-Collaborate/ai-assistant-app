import {
  delegation,
  override,
  policy,
} from '../../lib/services/limits/policyFixtures';
import { diffPolicies } from '@/lib/services/limits/policyChanges';
import { LimitsPolicy } from '@/lib/services/limits/types';

import {
  LimitsDraft,
  audienceRule,
  draftPolicy,
  exceptionCounts,
  revertChange,
  rulesForKey,
  withAudienceEntry,
  withEntry,
} from '@/components/Limits/limitsDraft';

import { describe, expect, it } from 'vitest';

/**
 * The edits every limits screen makes go through these helpers. The undo
 * test is the one that matters most: reverting one change from the review
 * must remove exactly that change and leave every other edit in place.
 */

function draftOf(subject: LimitsPolicy): LimitsDraft {
  return {
    defaults: subject.defaults,
    modelAccess: subject.modelAccess,
    overrides: subject.overrides,
    delegations: subject.delegations,
    mode: subject.mode,
    failMode: subject.failMode,
    timezone: subject.timezone,
    countByomUsage: subject.countByomUsage,
    countAuxiliaryUsage: subject.countAuxiliaryUsage,
  };
}

describe('withEntry', () => {
  const cell = { limitKey: 'chat.messagesPerDay' };

  it('adds, changes, keeps the ceiling flag, and removes on inherit', () => {
    const added = withEntry([], cell, 200);
    expect(added).toEqual([{ ...cell, value: 200, ceiling: false }]);
    const flagged = withEntry(added, cell, 200, true);
    expect(withEntry(flagged, cell, 300)[0]).toMatchObject({
      value: 300,
      ceiling: true,
    });
    expect(withEntry(flagged, cell, undefined)).toEqual([]);
  });

  it('keeps model and family cells apart from the unqualified one', () => {
    const entries = withEntry(
      withEntry([], { limitKey: 'model.requests' }, 500),
      { limitKey: 'model.requests', series: 'gpt' },
      50,
    );
    expect(entries).toHaveLength(2);
    expect(
      withEntry(entries, { limitKey: 'model.requests' }, undefined),
    ).toEqual([
      { limitKey: 'model.requests', series: 'gpt', value: 50, ceiling: false },
    ]);
  });
});

describe('rulesForKey and exceptionCounts', () => {
  const del = delegation('del-0000000000aa', []);
  const rules = [
    override('domain', ['a.org'], [{ value: 10 }]),
    override('user', ['x@a.org'], [{ value: 20 }]),
    override('domain', ['b.org'], [{ value: 30 }], { delegationId: del.id }),
    override('group', ['g'], [{ value: 40 }], { enabled: false }),
    override('group', ['g'], [{ limitKey: 'chat.tokensPerDay', value: 1 }]),
  ];

  it('lists the rules that set a key, most specific audience first', () => {
    expect(
      rulesForKey(rules, 'chat.messagesPerDay').map((r) => r.override.scope),
    ).toEqual(['user', 'group', 'domain', 'domain']);
  });

  it('counts enabled rules by audience, split by who set them', () => {
    const counts = exceptionCounts(rules, 'chat.messagesPerDay');
    expect(counts.domain).toEqual({ global: 1, delegated: 1 });
    expect(counts.user).toEqual({ global: 1, delegated: 0 });
    // The disabled group rule is not an exception in force.
    expect(counts.group).toEqual({ global: 0, delegated: 0 });
  });
});

describe('draftPolicy', () => {
  it('carries the saved group labels and stamps, and the draft’s own fields', () => {
    const saved = policy([{ value: 1 }], [], {
      groupLabels: { g: 'Group' },
    });
    const draft = { ...draftOf(saved), timezone: 'Europe/Paris' };
    const result = draftPolicy(draft, saved);
    expect(result.groupLabels).toEqual({ g: 'Group' });
    expect(result.timezone).toBe('Europe/Paris');
    expect(result.version).toBe(1);
  });
});

describe('revertChange', () => {
  it('undoes each kind of change on its own, leaving the others', () => {
    const del = delegation('del-0000000000bb', []);
    const kept = override('group', ['g-1'], [{ value: 500 }]);
    const dropped = override('domain', ['d.org'], [{ value: 5 }]);
    const saved = policy([{ value: 200 }], [kept, dropped]);

    const added = override('user', ['p@d.org'], [{ value: null }]);
    const draft: LimitsDraft = {
      ...draftOf(saved),
      defaults: withEntry(
        saved.defaults,
        { limitKey: 'chat.messagesPerDay' },
        100,
      ),
      overrides: [{ ...kept, enabled: false }, added],
      delegations: [del],
      mode: 'enforce',
    };
    const changes = diffPolicies(saved, draftPolicy(draft, saved));
    expect(changes.length).toBeGreaterThanOrEqual(6);

    // A change's identity: what it is about, not its resolved numbers,
    // which legitimately move when another change is undone (members of a
    // switched-off rule fall back to Everyone's value).
    const identity = (c: (typeof changes)[number]) =>
      JSON.stringify([
        c.type,
        'audience' in c ? c.audience : null,
        'cell' in c ? c.cell : null,
        'change' in c ? c.change : null,
        'subject' in c ? c.subject : null,
      ]);
    for (const change of changes) {
      const reverted = revertChange(draft, saved, change);
      const after = diffPolicies(saved, draftPolicy(reverted, saved)).map(
        identity,
      );
      // That change is gone...
      expect(after).not.toContain(identity(change));
      // ...and every other change is still there. The exception is a rule
      // switched on or off together with the value changes it causes: those
      // are one edit, so undoing either undoes both.
      const ruleOf = (c: (typeof changes)[number]) =>
        'audience' in c && c.audience.kind === 'rule'
          ? c.audience.overrideId
          : null;
      for (const other of changes) {
        if (other === change) continue;
        const coupled =
          change.type !== other.type &&
          ruleOf(change) !== null &&
          ruleOf(change) === ruleOf(other);
        if (coupled) continue;
        expect(after).toContain(identity(other));
      }
    }
  });
});

describe('audienceRule and withAudienceEntry', () => {
  const cell = { limitKey: 'chat.messagesPerDay' };
  const del = delegation('del-0000000000cc', []);
  const shared = override('user', ['a@x.org', 'b@x.org'], [{ value: 10 }]);
  const scoped = override('user', ['a@x.org'], [{ value: 20 }], {
    delegationId: del.id,
  });
  const create = () => override('user', [], []);

  it('ignores rules shared with others or owned by a delegated admin', () => {
    expect(audienceRule([shared, scoped], 'user', 'a@x.org')).toBeUndefined();
    const own = override('user', ['A@x.org'], [{ value: 30 }]);
    expect(audienceRule([shared, scoped, own], 'user', 'a@X.org')).toBe(own);
  });

  it('creates the audience rule on the first value and drops it when emptied', () => {
    const options = { savedIds: new Set<string>(), create };
    const audience = { scope: 'user' as const, target: ' A@x.org ' };
    const added = withAudienceEntry([shared], audience, cell, 500, options);
    expect(added).toHaveLength(2);
    expect(added[1]).toMatchObject({
      scope: 'user',
      targets: ['a@x.org'],
      entries: [{ ...cell, value: 500, ceiling: false }],
    });
    // The shared rule is untouched.
    expect(added[0]).toBe(shared);
    expect(
      withAudienceEntry(added, audience, cell, undefined, options),
    ).toEqual([shared]);
    // Inherit with no rule is a no-op, and an empty target changes nothing.
    expect(
      withAudienceEntry([shared], audience, cell, undefined, options),
    ).toEqual([shared]);
    expect(
      withAudienceEntry(
        [shared],
        { scope: 'user', target: ' ' },
        cell,
        5,
        options,
      ),
    ).toEqual([shared]);
  });

  it('keeps an emptied STORED rule, and switches a disabled one on when set', () => {
    const own = override('group', ['g-1'], [{ value: 30 }], { enabled: false });
    const options = { savedIds: new Set([own.id]), create };
    const audience = { scope: 'group' as const, target: 'g-1' };
    const emptied = withAudienceEntry(
      [own],
      audience,
      cell,
      undefined,
      options,
    );
    expect(emptied).toHaveLength(1);
    expect(emptied[0]).toMatchObject({
      id: own.id,
      entries: [],
      enabled: false,
    });
    const set = withAudienceEntry([own], audience, cell, null, options);
    expect(set[0]).toMatchObject({ enabled: true, entries: [{ value: null }] });
  });
});
