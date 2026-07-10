import {
  getFamilyVariants,
  getSeriesVersions,
  getVariantVersions,
  pickVariantTarget,
  seriesRepresentative,
  versionRank,
} from '@/lib/utils/app/modelSeries';

import { OpenAIModel } from '@/types/openai';

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
