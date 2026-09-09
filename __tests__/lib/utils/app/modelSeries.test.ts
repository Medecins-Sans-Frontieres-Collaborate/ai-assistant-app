import {
  getFamilyVariants,
  getSeriesVersions,
  getVariantVersionGroups,
  getVariantVersions,
  getVersionMembers,
  getVersionSubVariants,
  groupIntoFamilyUnits,
  pickVariantTarget,
  pickVersionTarget,
  seriesRepresentative,
  versionRank,
} from '@/lib/utils/app/modelSeries';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const model = (
  id: string,
  versionLabel?: string,
  extra: Partial<OpenAIModel> = {},
): OpenAIModel => ({
  id,
  name: id,
  maxLength: 1,
  tokenLimit: 1,
  series: 'gpt',
  versionLabel,
  ...extra,
});

describe('versionRank', () => {
  it('parses numeric version labels, including suffixed ones', () => {
    expect(versionRank({ versionLabel: '5.4' })).toBe(5.4);
    expect(versionRank({ versionLabel: '4o' })).toBe(4);
    expect(versionRank({ versionLabel: '3.2' })).toBe(3.2);
  });

  it('ranks unparseable/missing labels last', () => {
    expect(versionRank({ versionLabel: undefined })).toBe(-1);
    expect(versionRank({ versionLabel: 'preview' })).toBe(-1);
  });

  it('ranks the rolling "latest" alias above every numbered version', () => {
    expect(versionRank({ versionLabel: 'latest' })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('getSeriesVersions', () => {
  it('returns series members newest-first and ignores other series', () => {
    const models = [
      model('gpt-4.1', '4.1'),
      model('other', '9', { series: 'other' }),
      model('gpt-5.4', '5.4'),
      model('gpt-5', '5'),
    ];
    expect(
      getSeriesVersions(models, { series: 'gpt' }).map((m) => m.id),
    ).toEqual(['gpt-5.4', 'gpt-5', 'gpt-4.1']);
  });

  it('returns [] when the model has no series', () => {
    expect(getSeriesVersions([model('x', '1')], { series: undefined })).toEqual(
      [],
    );
  });
});

describe('seriesRepresentative', () => {
  const versions = [
    model('gpt-5.4', '5.4'),
    model('gpt-5.2', '5.2', { tier: 'featured' }),
    model('gpt-5', '5', { tier: 'legacy' }),
  ];

  it('prefers the current selection', () => {
    expect(seriesRepresentative(versions, 'gpt-5')?.id).toBe('gpt-5');
  });

  it('prefers the FEATURED version over the newest (row fronts the vetted default)', () => {
    expect(seriesRepresentative(versions, undefined)?.id).toBe('gpt-5.2');
  });

  it('falls back to newest non-legacy, then newest', () => {
    const noFeatured = [
      model('gpt-5.4', '5.4', { tier: 'legacy' }),
      model('gpt-5.2', '5.2'),
    ];
    expect(seriesRepresentative(noFeatured, undefined)?.id).toBe('gpt-5.2');
    const allLegacy = [model('gpt-5.4', '5.4', { tier: 'legacy' })];
    expect(seriesRepresentative(allLegacy, undefined)?.id).toBe('gpt-5.4');
  });

  it('prefers the lowest defaultRank over featured, ties going to the newest', () => {
    // Newest-first, like getSeriesVersions output. Sonnet-shaped scenario:
    // every sonnet carries rank 1, so the newest available one wins even
    // though an Opus is featured.
    const versions = [
      model('opus-new', '4.8', { tier: 'featured', defaultRank: 2 }),
      model('sonnet-new', '4.6', { defaultRank: 1 }),
      model('sonnet-old', '4.5', { defaultRank: 1 }),
    ];
    expect(seriesRepresentative(versions, undefined)?.id).toBe('sonnet-new');
    // The selection still beats defaultRank.
    expect(seriesRepresentative(versions, 'sonnet-old')?.id).toBe('sonnet-old');
    // When ranked members are unavailable (filtered out), featured wins.
    expect(
      seriesRepresentative([model('x', '1', { tier: 'featured' })]),
    ).toEqual(model('x', '1', { tier: 'featured' }));
  });

  it('walks the DeepSeek-style cross-variant preference as availability shrinks', () => {
    const flash = model('v4-flash', '4', { defaultRank: 1 });
    const pro = model('v4-pro', '4', { defaultRank: 2 });
    const v32 = model('v3.2', '3.2', { defaultRank: 3 });
    const v31 = model('v3.1', '3.1', { defaultRank: 3 });
    expect(seriesRepresentative([flash, pro, v32, v31])?.id).toBe('v4-flash');
    expect(seriesRepresentative([pro, v32, v31])?.id).toBe('v4-pro');
    expect(seriesRepresentative([v32, v31])?.id).toBe('v3.2');
    expect(seriesRepresentative([v31])?.id).toBe('v3.1');
  });
});

describe('seriesRepresentative with an isSelectable gate (usage limits)', () => {
  const featured = model('gpt-5.2', '5.2', { tier: 'featured' });
  const newest = model('gpt-5.4', '5.4');
  const legacy = model('gpt-5', '5', { tier: 'legacy' });
  const versions = [newest, featured, legacy];
  const notIn = (ids: string[]) => (m: OpenAIModel) => !ids.includes(m.id);

  it('skips a spent default and fronts the best still-usable sibling', () => {
    expect(
      seriesRepresentative(versions, undefined, notIn(['gpt-5.2']))?.id,
    ).toBe('gpt-5.4');
  });

  it('keeps the normal preference order among usable members', () => {
    // Newest spent → featured (5.2) still wins over legacy.
    expect(
      seriesRepresentative(versions, undefined, notIn(['gpt-5.4']))?.id,
    ).toBe('gpt-5.2');
    // Newest and featured spent → the legacy one is all that's left usable.
    expect(
      seriesRepresentative(versions, undefined, notIn(['gpt-5.4', 'gpt-5.2']))
        ?.id,
    ).toBe('gpt-5');
  });

  it('falls back to the ungated pick when the whole family is spent (row grays instead of vanishing)', () => {
    expect(seriesRepresentative(versions, undefined, () => false)?.id).toBe(
      'gpt-5.2',
    );
  });

  it('lets the current selection win even when it is the spent one', () => {
    expect(
      seriesRepresentative(versions, 'gpt-5.2', notIn(['gpt-5.2']))?.id,
    ).toBe('gpt-5.2');
  });

  it('is a no-op when every member is usable', () => {
    expect(seriesRepresentative(versions, undefined, () => true)?.id).toBe(
      seriesRepresentative(versions, undefined)?.id,
    );
  });
});

describe('pickVariantTarget with an isSelectable gate', () => {
  const mini54 = model('gpt-5.4-mini', '5.4', { variant: 'mini' });
  const mini52 = model('gpt-5.2-mini', '5.2', {
    variant: 'mini',
    tier: 'featured',
  });
  const mini5 = model('gpt-5-mini', '5', { variant: 'mini', tier: 'legacy' });
  const members = [mini54, mini52, mini5];
  const notIn = (ids: string[]) => (m: OpenAIModel) => !ids.includes(m.id);

  it('keeps the same-version shortcut while that version is usable', () => {
    expect(pickVariantTarget(members, '5.4', notIn(['gpt-5-mini']))?.id).toBe(
      'gpt-5.4-mini',
    );
  });

  it('routes past a spent same-version twin to the best usable sibling', () => {
    expect(pickVariantTarget(members, '5.4', notIn(['gpt-5.4-mini']))?.id).toBe(
      'gpt-5.2-mini',
    );
  });

  it('behaves exactly as ungated when nothing in the variant is usable', () => {
    expect(pickVariantTarget(members, '5.4', () => false)?.id).toBe(
      pickVariantTarget(members, '5.4')?.id,
    );
    expect(pickVariantTarget(members, undefined, () => false)?.id).toBe(
      pickVariantTarget(members, undefined)?.id,
    );
  });
});

describe('groupIntoFamilyUnits', () => {
  it('buckets series members into one unit anchored at first appearance, plain rows in place', () => {
    // Ids deliberately not in the catalog: series comes from the objects.
    const models = [
      model('byom-x-large', '3', { series: 'byom-x:mistral' }),
      model('byom-x-plain', undefined, { series: undefined }),
      model('byom-x-medium', '2505', { series: 'byom-x:mistral' }),
      model('byom-x-other', '1', { series: 'byom-x:other' }),
      model('byom-x-small', '2503', { series: 'byom-x:mistral' }),
    ];
    const units = groupIntoFamilyUnits(models);
    expect(units.map((u) => u.key)).toEqual([
      'series-byom-x:mistral',
      'byom-x-plain',
      'series-byom-x:other',
    ]);
    // Family unit: anchored at the first member, keeps input order.
    expect(units[0].seriesKey).toBe('byom-x:mistral');
    expect(units[0].members.map((m) => m.id)).toEqual([
      'byom-x-large',
      'byom-x-medium',
      'byom-x-small',
    ]);
    // Plain row: single member, no seriesKey.
    expect(units[1].seriesKey).toBeUndefined();
    expect(units[1].members.map((m) => m.id)).toEqual(['byom-x-plain']);
    // A single-member series still yields a family unit (the render layer
    // decides that one-version families draw as plain cards).
    expect(units[2].seriesKey).toBe('byom-x:other');
    expect(units[2].members).toHaveLength(1);
  });

  it('reads the series from static catalog metadata when the id is known', () => {
    // Runtime model objects can arrive without family fields (e.g. the
    // /api/models merge); renderTypeBlock semantics resolve the series via
    // the catalog entry, so the helper must too.
    const catalogSeries = OpenAIModels[OpenAIModelID.GPT_5_2].series;
    expect(catalogSeries).toBeDefined();
    const bare = model(OpenAIModelID.GPT_5_2, undefined, {
      series: undefined,
    });
    // The unknown-id sibling carries series 'gpt' on the object (the local
    // helper's default) — same key as the catalog entry, so both join one
    // unit: catalog lookup and object fallback feed the same bucketing.
    const units = groupIntoFamilyUnits([bare, model('gpt-9-unknown', '9')]);
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe(`series-${catalogSeries}`);
    expect(units[0].seriesKey).toBe(catalogSeries);
    expect(units[0].members.map((m) => m.id)).toEqual([
      OpenAIModelID.GPT_5_2,
      'gpt-9-unknown',
    ]);
  });

  it('returns no units for an empty list', () => {
    expect(groupIntoFamilyUnits([])).toEqual([]);
  });
});

// A ragged two-variant family for the variant helpers: Standard has three
// versions, Mini has two (no 5.2 mini), plus one member with no variant.
const family = [
  model('gpt-5.2', '5.2', { variant: 'standard', variantLabel: 'Standard' }),
  model('gpt-5-mini', '5', { variant: 'mini', variantLabel: 'Mini' }),
  model('gpt-5.4', '5.4', { variant: 'standard', variantLabel: 'Standard' }),
  model('gpt-4.1-mini', '4.1', { variant: 'mini', variantLabel: 'Mini' }),
  model('gpt-5', '5', { variant: 'standard', variantLabel: 'Standard' }),
];

describe('getFamilyVariants', () => {
  it('buckets members per variant in order of first appearance', () => {
    const variants = getFamilyVariants(family);
    expect(variants.map((v) => v.key)).toEqual(['standard', 'mini']);
    expect(variants[0].label).toBe('Standard');
    expect(variants[1].members.map((m) => m.id)).toEqual([
      'gpt-5-mini',
      'gpt-4.1-mini',
    ]);
  });

  it('orders variants by variantRank regardless of appearance order', () => {
    // Claude-shaped: haiku appears first in the list but ranks last.
    const variants = getFamilyVariants([
      model('haiku', '4.5', { variant: 'haiku', variantRank: 3 }),
      model('sonnet', '4.6', { variant: 'sonnet', variantRank: 2 }),
      model('opus', '4.8', { variant: 'opus', variantRank: 1 }),
    ]);
    expect(variants.map((v) => v.key)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it("groups members without a variant under the '' bucket", () => {
    const variants = getFamilyVariants([model('a', '1'), model('b', '2')]);
    expect(variants).toHaveLength(1);
    expect(variants[0].key).toBe('');
  });
});

describe('getVariantVersions', () => {
  it("returns only the active variant's versions, newest first", () => {
    expect(
      getVariantVersions(family, { series: 'gpt', variant: 'mini' }).map(
        (m) => m.id,
      ),
    ).toEqual(['gpt-5-mini', 'gpt-4.1-mini']);
  });

  it('treats a missing variant as its own single-variant bucket', () => {
    const mixed = [...family, model('gpt-x', '9')];
    expect(
      getVariantVersions(mixed, { series: 'gpt', variant: undefined }).map(
        (m) => m.id,
      ),
    ).toEqual(['gpt-x']);
  });
});

describe('pickVariantTarget', () => {
  const minis = getVariantVersions(family, { series: 'gpt', variant: 'mini' });

  it('keeps the current version when the target variant has it', () => {
    expect(pickVariantTarget(minis, '4.1')?.id).toBe('gpt-4.1-mini');
  });

  it("falls back to the variant's representative when the version is missing (ragged matrix)", () => {
    // No 5.2 mini exists → newest non-legacy mini.
    expect(pickVariantTarget(minis, '5.2')?.id).toBe('gpt-5-mini');
  });

  it('prefers a featured member over a same-rank newer one on fallback', () => {
    const withFeatured = [
      model('m-new', '6', { variant: 'mini' }),
      model('m-featured', '5', { variant: 'mini', tier: 'featured' }),
    ];
    expect(pickVariantTarget(withFeatured, '9.9')?.id).toBe('m-featured');
  });
});

// A family whose ONE version ships several models — the shape the
// sub-variant axis exists for (GPT 5.6's Sol/Terra/Luna, o-series 3's
// o3/o3-mini). Deliberately declared out of rank order.
const subVariantFamily = [
  model('astra', '6', { variant: 'standard' }),
  model('terra', '5.6', {
    variant: 'standard',
    subVariant: 'terra',
    subVariantLabel: 'Terra',
    subVariantRank: 2,
  }),
  model('luna', '5.6', {
    variant: 'standard',
    subVariant: 'luna',
    subVariantLabel: 'Luna',
    subVariantRank: 3,
  }),
  model('sol', '5.6', {
    variant: 'standard',
    subVariant: 'sol',
    subVariantLabel: 'Sol',
    subVariantRank: 1,
    defaultRank: 1,
  }),
  model('gpt-5.4', '5.4', { variant: 'standard' }),
];

describe('getVersionSubVariants', () => {
  it('orders sub-variants by subVariantRank, not declaration order', () => {
    const members = getVersionMembers(subVariantFamily, {
      series: 'gpt',
      variant: 'standard',
      versionLabel: '5.6',
    });
    expect(getVersionSubVariants(members).map((s) => s.key)).toEqual([
      'sol',
      'terra',
      'luna',
    ]);
  });

  it('puts unranked sub-variants last, in order of appearance', () => {
    const ordered = getVersionSubVariants([
      model('c', '1', { subVariant: 'c' }),
      model('a', '1', { subVariant: 'a', subVariantRank: 1 }),
      model('d', '1', { subVariant: 'd' }),
    ]);
    expect(ordered.map((s) => s.key)).toEqual(['a', 'c', 'd']);
  });
});

describe('getVariantVersionGroups', () => {
  it('collapses a version that ships several models into ONE chip', () => {
    const groups = getVariantVersionGroups(subVariantFamily, {
      series: 'gpt',
      variant: 'standard',
    });
    // Newest first, and 5.6 appears once rather than three times — the
    // duplicate-chip collision this axis exists to prevent.
    expect(groups.map((g) => g.key)).toEqual(['6', '5.6', '5.4']);
    expect(groups[1].members.map((m) => m.id)).toEqual([
      'sol',
      'terra',
      'luna',
    ]);
  });

  it('leaves single-model versions as one-member groups', () => {
    const groups = getVariantVersionGroups(family, {
      series: 'gpt',
      variant: 'mini',
    });
    expect(groups.map((g) => g.key)).toEqual(['5', '4.1']);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
  });
});

describe('pickVersionTarget', () => {
  const members = getVersionMembers(subVariantFamily, {
    series: 'gpt',
    variant: 'standard',
    versionLabel: '5.6',
  });

  it("keeps the user's sub-variant when the version offers it", () => {
    expect(pickVersionTarget(members, 'luna')?.id).toBe('luna');
  });

  it("falls back to the version's representative when it does not", () => {
    // No 'nano' sub-variant here, so the defaultRank member fronts it.
    expect(pickVersionTarget(members, 'nano')?.id).toBe('sol');
    expect(pickVersionTarget(members, undefined)?.id).toBe('sol');
  });

  it('skips a sub-variant the caller cannot select', () => {
    const usable = (m: OpenAIModel) => m.id !== 'luna';
    expect(pickVersionTarget(members, 'luna', usable)?.id).toBe('sol');
  });

  it('ignores the gate when NOTHING in the version qualifies', () => {
    // The caller still needs a target to badge and render disabled.
    expect(pickVersionTarget(members, 'luna', () => false)?.id).toBe('luna');
  });
});

describe('pickVariantTarget across sub-variants', () => {
  it('keeps version AND sub-variant when the target variant has both', () => {
    const miniAtSameVersion = [
      model('mini-5.6-sol', '5.6', {
        variant: 'mini',
        subVariant: 'sol',
        subVariantRank: 1,
      }),
      model('mini-5.6-luna', '5.6', {
        variant: 'mini',
        subVariant: 'luna',
        subVariantRank: 2,
      }),
    ];
    expect(
      pickVariantTarget(miniAtSameVersion, '5.6', undefined, 'luna')?.id,
    ).toBe('mini-5.6-luna');
  });

  it('keeps the version when the sub-variant is not offered there', () => {
    const miniAtSameVersion = [
      model('mini-5.6', '5.6', { variant: 'mini' }),
      model('mini-5.4', '5.4', { variant: 'mini' }),
    ];
    expect(
      pickVariantTarget(miniAtSameVersion, '5.6', undefined, 'luna')?.id,
    ).toBe('mini-5.6');
  });
});
