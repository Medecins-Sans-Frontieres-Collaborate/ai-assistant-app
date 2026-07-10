import {
  EMISSIONS_ASSUMPTIONS,
  estimateCO2Grams,
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
