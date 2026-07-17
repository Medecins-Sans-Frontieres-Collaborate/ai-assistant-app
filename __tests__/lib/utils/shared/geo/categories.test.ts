import {
  MAX_CATEGORY_CHIPS,
  OTHER_CATEGORY_KEY,
  buildCategoryChips,
  featureMatchesCategories,
  normalizeCategoryKey,
} from '@/lib/utils/shared/geo/categories';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const feature = (category: string, id = category): MapFeature => ({
  id,
  name: id,
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category,
});

describe('normalizeCategoryKey', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizeCategoryKey('  Field   Hospital ')).toBe('field hospital');
  });
  it('handles undefined', () => {
    expect(normalizeCategoryKey(undefined)).toBe('');
  });
});

describe('buildCategoryChips', () => {
  it('groups case variants under one chip with the most frequent spelling', () => {
    const { chips } = buildCategoryChips([
      feature('Hospital', 'a'),
      feature('hospital', 'b'),
      feature('hospital', 'c'),
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      key: 'hospital',
      label: 'hospital',
      count: 3,
    });
  });

  it('caps chips and rolls the tail plus empties into Other', () => {
    const features = [
      // 10 distinct categories, two features each for the first 8
      ...Array.from({ length: MAX_CATEGORY_CHIPS }, (_, i) => [
        feature(`cat${i}`, `cat${i}-1`),
        feature(`cat${i}`, `cat${i}-2`),
      ]).flat(),
      feature('tail-a', 'x1'),
      feature('tail-b', 'x2'),
      feature('', 'empty1'),
    ];
    const { chips, chipKeys } = buildCategoryChips(features);

    expect(chips).toHaveLength(MAX_CATEGORY_CHIPS + 1);
    const other = chips[chips.length - 1];
    expect(other.key).toBe(OTHER_CATEGORY_KEY);
    expect(other.count).toBe(3); // tail-a + tail-b + empty
    expect(chipKeys.has('tail-a')).toBe(false);
  });

  it('omits the other chip when everything earned a chip', () => {
    const { chips } = buildCategoryChips([feature('a'), feature('b')]);
    expect(chips.every((c) => c.key !== OTHER_CATEGORY_KEY)).toBe(true);
  });
});

describe('featureMatchesCategories', () => {
  const all = [
    feature('hospital', 'h'),
    feature('camp', 'c'),
    feature('', 'uncat'),
  ];
  const { chipKeys } = buildCategoryChips(all);

  it('matches everything with an empty active set', () => {
    expect(
      all.every((f) => featureMatchesCategories(f, new Set(), chipKeys)),
    ).toBe(true);
  });

  it('matches only active chips', () => {
    const active = new Set(['hospital']);
    expect(featureMatchesCategories(all[0], active, chipKeys)).toBe(true);
    expect(featureMatchesCategories(all[1], active, chipKeys)).toBe(false);
  });

  it('Other matches uncategorized features', () => {
    const active = new Set([OTHER_CATEGORY_KEY]);
    expect(featureMatchesCategories(all[2], active, chipKeys)).toBe(true);
    expect(featureMatchesCategories(all[0], active, chipKeys)).toBe(false);
  });
});
