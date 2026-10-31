/**
 * The model approval tree helper (docs/LIMITS.md "Model approval"): tree
 * shape from the catalog, rule bookkeeping, and the EFFECTIVE default for
 * everyone else — resolved with the real resolver, so the view cannot
 * disagree with the send.
 */
import type { LimitEntry, ModelAccessRule } from '@/lib/services/limits/types';

import {
  buildModelAccessTree,
  catalogModelsForAdmin,
  collidesWithDefaults,
  effectiveAccessFor,
  emptyRule,
  externalFamilyLabels,
  isEmptyRule,
  ruleFor,
  upsertRule,
} from '@/lib/utils/app/modelAccessTree';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const model = (
  id: string,
  series: string | undefined,
  extra: Partial<OpenAIModel> = {},
): OpenAIModel =>
  ({
    id,
    name: id.toUpperCase(),
    maxLength: 1,
    tokenLimit: 1,
    ...(series ? { series, seriesLabel: series.toUpperCase() } : {}),
    ...extra,
  }) as OpenAIModel;

const rule = (partial: Partial<ModelAccessRule>): ModelAccessRule => ({
  groups: [],
  domains: [],
  allow: [],
  deny: [],
  ...partial,
});

describe('buildModelAccessTree', () => {
  it('groups models under their family, ranks by variantRank then label, and lists series-less models apart', () => {
    const tree = buildModelAccessTree(
      [
        model('b-mini', 'fam', { variantRank: 2 }),
        model('a-big', 'fam', { variantRank: 1 }),
        model('loner', undefined),
      ],
      [],
    );
    expect(tree.families).toHaveLength(1);
    expect(tree.families[0].series).toBe('fam');
    expect(tree.families[0].models.map((m) => m.modelId)).toEqual([
      'a-big',
      'b-mini',
    ]);
    expect(tree.orphans.map((m) => m.modelId)).toEqual(['loner']);
  });

  it('keeps nodes for stored rules this ring does not serve, flagged unknown', () => {
    const tree = buildModelAccessTree(
      [model('x', 'fam')],
      [
        rule({ series: 'ghost', defaultAccess: false }),
        rule({ modelId: 'gone' }),
      ],
    );
    const ghost = tree.families.find((f) => f.series === 'ghost');
    expect(ghost?.known).toBe(false);
    expect(tree.orphans.find((m) => m.modelId === 'gone')?.known).toBe(false);
    expect(tree.families.find((f) => f.series === 'fam')?.known).toBe(true);
  });

  it('catalogModelsForAdmin puts the static catalog under the live list so an admin sees families they are not granted', () => {
    const merged = catalogModelsForAdmin([
      model('gpt-5.4', 'gpt', { name: 'Live name' }),
    ]);
    expect(merged.some((m) => m.series === 'claude')).toBe(true);
    expect(merged.find((m) => m.id === 'gpt-5.4')?.name).toBe('Live name');
    expect(externalFamilyLabels(buildModelAccessTree(merged, []))).toEqual([
      'Claude',
    ]);
  });
});

describe('rule bookkeeping', () => {
  it('ruleFor matches case-insensitively and never confuses a model rule with a family rule', () => {
    const rules = [
      rule({ series: 'Claude', defaultAccess: false }),
      rule({ modelId: 'claude-sonnet-5', defaultAccess: null }),
    ];
    expect(ruleFor(rules, { series: 'claude' })?.defaultAccess).toBe(false);
    expect(ruleFor(rules, { modelId: 'CLAUDE-SONNET-5' })?.defaultAccess).toBe(
      null,
    );
    expect(ruleFor(rules, { modelId: 'claude' })).toBeUndefined();
  });

  it('upsertRule inserts, replaces in place, and drops a rule that says nothing', () => {
    const start = [rule({ series: 'a', defaultAccess: false })];
    const added = upsertRule(
      start,
      { series: 'b' },
      rule({ series: 'b', deny: ['x@y.org'] }),
    );
    expect(added.map((r) => r.series)).toEqual(['a', 'b']);
    const replaced = upsertRule(
      added,
      { series: 'a' },
      rule({ series: 'a', defaultAccess: null }),
    );
    expect(replaced[0].defaultAccess).toBeNull();
    const dropped = upsertRule(
      replaced,
      { series: 'a' },
      emptyRule({ series: 'a' }),
    );
    expect(dropped.map((r) => r.series)).toEqual(['b']);
    expect(isEmptyRule(emptyRule({ modelId: 'm' }))).toBe(true);
  });

  it('collidesWithDefaults only when the node sets a default AND the generic defaults set the same cell', () => {
    const defaults: LimitEntry[] = [
      {
        limitKey: 'model.allowed',
        series: 'claude',
        value: true,
        ceiling: false,
      },
    ];
    expect(
      collidesWithDefaults(
        { series: 'claude' },
        rule({ series: 'claude', defaultAccess: null }),
        defaults,
      ),
    ).toBe(true);
    expect(
      collidesWithDefaults(
        { series: 'claude' },
        rule({ series: 'claude' }),
        defaults,
      ),
    ).toBe(false);
    expect(
      collidesWithDefaults(
        { modelId: 'claude-sonnet-5' },
        rule({ modelId: 'claude-sonnet-5', defaultAccess: null }),
        defaults,
      ),
    ).toBe(false);
  });
});

describe('effectiveAccessFor', () => {
  it('an external family is unavailable by catalog; its models inherit that', () => {
    expect(effectiveAccessFor({ series: 'claude' }, undefined, [], [])).toEqual(
      {
        state: { kind: 'unavailable' },
        origin: 'catalogExternal',
      },
    );
    expect(
      effectiveAccessFor({ modelId: 'claude-sonnet-5' }, 'claude', [], []),
    ).toEqual({ state: { kind: 'unavailable' }, origin: 'catalogExternal' });
    expect(effectiveAccessFor({ modelId: 'gpt-5.4' }, 'gpt', [], [])).toEqual({
      state: { kind: 'unlimited' },
      origin: 'catalog',
    });
  });

  it('a model inherits its family rule, and overrides it with its own', () => {
    const rules = [rule({ series: 'claude', defaultAccess: 50 })];
    expect(
      effectiveAccessFor({ modelId: 'claude-sonnet-5' }, 'claude', [], rules),
    ).toEqual({ state: { kind: 'limited', requests: 50 }, origin: 'family' });
    const own = [
      ...rules,
      rule({ modelId: 'claude-sonnet-5', defaultAccess: null }),
    ];
    // Unlimited on the model, but the family budget of 50 still binds.
    expect(
      effectiveAccessFor({ modelId: 'claude-sonnet-5' }, 'claude', [], own),
    ).toEqual({ state: { kind: 'limited', requests: 50 }, origin: 'model' });
    const blocked = [
      rule({ series: 'claude', defaultAccess: null }),
      rule({ modelId: 'claude-opus-5', defaultAccess: false }),
    ];
    expect(
      effectiveAccessFor({ modelId: 'claude-opus-5' }, 'claude', [], blocked),
    ).toEqual({ state: { kind: 'unavailable' }, origin: 'model' });
    expect(
      effectiveAccessFor({ series: 'claude' }, undefined, [], blocked),
    ).toEqual({
      state: { kind: 'unlimited' },
      origin: 'model',
    });
  });

  it('attributes the origin by what actually decided, not by which rule exists', () => {
    // A model-qualified global default outranks the family rule's block.
    const defaults: LimitEntry[] = [
      {
        limitKey: 'model.allowed',
        modelId: 'claude-opus-5',
        value: true,
        ceiling: false,
      },
    ];
    const rules = [rule({ series: 'claude', defaultAccess: false })];
    expect(
      effectiveAccessFor(
        { modelId: 'claude-opus-5' },
        'claude',
        defaults,
        rules,
      ),
    ).toEqual({ state: { kind: 'unlimited' }, origin: 'defaults' });
    expect(
      effectiveAccessFor(
        { modelId: 'claude-sonnet-5' },
        'claude',
        defaults,
        rules,
      ),
    ).toEqual({ state: { kind: 'unavailable' }, origin: 'family' });
    expect(
      effectiveAccessFor({ series: 'claude' }, undefined, defaults, rules),
    ).toEqual({ state: { kind: 'unavailable' }, origin: 'model' });
  });

  it('reads the generic global defaults when no rule speaks', () => {
    const defaults: LimitEntry[] = [
      { limitKey: 'model.requests', series: 'gpt', value: 200, ceiling: false },
    ];
    expect(
      effectiveAccessFor({ modelId: 'gpt-5.4' }, 'gpt', defaults, []),
    ).toEqual({
      state: { kind: 'limited', requests: 200 },
      origin: 'defaults',
    });
  });
});
