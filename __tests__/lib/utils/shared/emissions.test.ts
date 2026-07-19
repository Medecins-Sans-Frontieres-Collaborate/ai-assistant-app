import {
  EMISSIONS_ASSUMPTIONS,
  activityDurationParts,
  estimateActivityEquivalents,
  estimateCO2Grams,
  estimateTypicalRequestCO2,
  getEmissionsTier,
} from '@/lib/utils/shared/emissions';

import { describe, expect, it } from 'vitest';

/** Recompute the expected grams straight from the assumptions, so the test
 *  tracks config changes instead of hard-coding a magic number. */
function expected(
  prompt: number,
  completion: number,
  size: 'nano' | 'mini' | 'standard' | 'large',
  region: 'US' | 'EU' | 'default',
  opts: {
    effort?: 'minimal' | 'low' | 'medium' | 'high';
    dedicated?: boolean;
  } = {},
) {
  const a = EMISSIONS_ASSUMPTIONS;
  const eff = a.reasoningEffortMultipliers[opts.effort ?? 'none'];
  const ded = opts.dedicated ? a.dedicatedReasoningMultiplier : 1;
  const wh =
    ((prompt * a.promptTokenWeight + completion) / 1000) *
    a.whPer1kTokens[size] *
    eff *
    ded *
    a.pue;
  return (wh * a.gridIntensity[region]) / 1000;
}

describe('estimateCO2Grams', () => {
  it('scales with size class', () => {
    const nano = estimateCO2Grams({
      promptTokens: 0,
      completionTokens: 1000,
      sizeClass: 'nano',
      isDedicatedReasoner: false,
      region: 'US',
    }).gCO2e;
    const large = estimateCO2Grams({
      promptTokens: 0,
      completionTokens: 1000,
      sizeClass: 'large',
      isDedicatedReasoner: false,
      region: 'US',
    }).gCO2e;
    expect(large).toBeGreaterThan(nano);
    expect(nano).toBeCloseTo(expected(0, 1000, 'nano', 'US'), 9);
    expect(large).toBeCloseTo(expected(0, 1000, 'large', 'US'), 9);
  });

  it('discounts prompt tokens vs completion tokens', () => {
    const promptHeavy = estimateCO2Grams({
      promptTokens: 1000,
      completionTokens: 0,
      sizeClass: 'standard',
      isDedicatedReasoner: false,
      region: 'US',
    }).gCO2e;
    const completionHeavy = estimateCO2Grams({
      promptTokens: 0,
      completionTokens: 1000,
      sizeClass: 'standard',
      isDedicatedReasoner: false,
      region: 'US',
    }).gCO2e;
    expect(promptHeavy).toBeLessThan(completionHeavy);
    expect(promptHeavy).toBeCloseTo(expected(1000, 0, 'standard', 'US'), 9);
  });

  it('EU grid is cleaner than US for identical usage', () => {
    const us = estimateCO2Grams({
      promptTokens: 500,
      completionTokens: 500,
      sizeClass: 'standard',
      isDedicatedReasoner: false,
      region: 'US',
    }).gCO2e;
    const eu = estimateCO2Grams({
      promptTokens: 500,
      completionTokens: 500,
      sizeClass: 'standard',
      isDedicatedReasoner: false,
      region: 'EU',
    }).gCO2e;
    expect(eu).toBeLessThan(us);
  });

  it('null region maps to the default grid intensity', () => {
    const nul = estimateCO2Grams({
      promptTokens: 100,
      completionTokens: 100,
      sizeClass: 'standard',
      isDedicatedReasoner: false,
      region: null,
    }).gCO2e;
    expect(nul).toBeCloseTo(expected(100, 100, 'standard', 'default'), 9);
  });

  it('applies effort and dedicated-reasoner multipliers', () => {
    const base = estimateCO2Grams({
      promptTokens: 0,
      completionTokens: 1000,
      sizeClass: 'large',
      isDedicatedReasoner: false,
      region: 'US',
    }).gCO2e;
    const highEffort = estimateCO2Grams({
      promptTokens: 0,
      completionTokens: 1000,
      sizeClass: 'large',
      isDedicatedReasoner: false,
      reasoningEffort: 'high',
      region: 'US',
    }).gCO2e;
    const dedicated = estimateCO2Grams({
      promptTokens: 0,
      completionTokens: 1000,
      sizeClass: 'large',
      isDedicatedReasoner: true,
      region: 'US',
    }).gCO2e;
    expect(highEffort).toBeGreaterThan(base);
    expect(dedicated).toBeGreaterThan(base);
    expect(highEffort).toBeCloseTo(
      expected(0, 1000, 'large', 'US', { effort: 'high' }),
      9,
    );
  });

  it('returns the assumptions version for traceability', () => {
    expect(
      estimateCO2Grams({
        promptTokens: 1,
        completionTokens: 1,
        sizeClass: 'standard',
        isDedicatedReasoner: false,
        region: 'US',
      }).assumptionsVersion,
    ).toBe(EMISSIONS_ASSUMPTIONS.assumptionsVersion);
  });
});

describe('getEmissionsTier', () => {
  it('maps size classes to tiers', () => {
    expect(getEmissionsTier('nano', false)).toBe('low');
    expect(getEmissionsTier('mini', false)).toBe('low');
    expect(getEmissionsTier('standard', false)).toBe('moderate');
    expect(getEmissionsTier('large', false)).toBe('high');
  });

  it('bumps dedicated reasoners one tier (capped at high)', () => {
    expect(getEmissionsTier('nano', true)).toBe('moderate');
    expect(getEmissionsTier('mini', true)).toBe('moderate');
    expect(getEmissionsTier('standard', true)).toBe('high');
    expect(getEmissionsTier('large', true)).toBe('high');
  });
});

describe('estimateTypicalRequestCO2', () => {
  it('matches estimateCO2Grams for the configured typical request', () => {
    const { typicalRequest } = EMISSIONS_ASSUMPTIONS;
    const direct = estimateCO2Grams({
      promptTokens: typicalRequest.promptTokens,
      completionTokens: typicalRequest.completionTokens,
      sizeClass: 'standard',
      isDedicatedReasoner: false,
      region: null,
    });
    expect(estimateTypicalRequestCO2('standard', false).gCO2e).toBeCloseTo(
      direct.gCO2e,
      9,
    );
  });

  it('is positive and ordered by size class', () => {
    const nano = estimateTypicalRequestCO2('nano', false).gCO2e;
    const large = estimateTypicalRequestCO2('large', false).gCO2e;
    expect(nano).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(nano);
  });
});

describe('estimateActivityEquivalents', () => {
  it('computes seconds = 3600 × grams / activity grams-per-hour', () => {
    const activities = EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour;
    const equivalents = estimateActivityEquivalents(1);
    for (const equivalent of equivalents) {
      expect(equivalent.seconds).toBeCloseTo(
        3600 / activities[equivalent.key],
        9,
      );
    }
    // One entry per configured activity.
    expect(equivalents.map((e) => e.key).sort()).toEqual(
      Object.keys(activities).sort(),
    );
  });

  it('scales linearly with grams', () => {
    const one = estimateActivityEquivalents(1);
    const ten = estimateActivityEquivalents(10);
    expect(ten[0].seconds).toBeCloseTo(one[0].seconds * 10, 9);
  });
});

describe('activityDurationParts', () => {
  it('buckets durations into display units', () => {
    expect(activityDurationParts(0.4)).toEqual({
      unit: 'lessThanSecond',
      value: '',
    });
    expect(activityDurationParts(45)).toEqual({ unit: 'seconds', value: '45' });
    expect(activityDurationParts(91)).toEqual({
      unit: 'minutes',
      value: '1.5',
    });
    expect(activityDurationParts(600)).toEqual({
      unit: 'minutes',
      value: '10',
    });
    expect(activityDurationParts(3600 * 1.53)).toEqual({
      unit: 'hours',
      value: '1.5',
    });
    expect(activityDurationParts(3600 * 26)).toEqual({
      unit: 'hours',
      value: '26',
    });
  });
});
