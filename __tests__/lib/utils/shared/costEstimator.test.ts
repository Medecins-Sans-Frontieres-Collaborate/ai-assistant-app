import {
  resolveLimit,
  resolveModelCells,
} from '@/lib/services/limits/resolver';
import type { ResolvedLimit } from '@/lib/services/limits/resolver';
import { LimitsPolicy, LimitsPolicySchema } from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import {
  COST_ASSUMPTIONS,
  COST_ASSUMPTIONS_VERSION,
  COST_PERIODS,
  CostPeriod,
  EstimateInput,
  blendedPerTokenUsd,
  boundRequests,
  deploymentMultiplierFor,
  estimateRequestCost,
  estimateSpend,
  estimateSpendWithCaps,
  findPricing,
  formatUsdParts,
  outputMultiplierFor,
  outputPerTokenUsd,
  perThousandRequestsUsd,
  resolveProfile,
} from '@/lib/utils/shared/costEstimator';
import { EMISSIONS_ASSUMPTIONS } from '@/lib/utils/shared/emissions';

import {
  OpenAIModel,
  OpenAIModels,
  PRICING_ASSUMPTIONS_VERSION,
  PRICING_AS_OF,
} from '@/types/openai';

import { getLimitDefinition } from '@/config/limits';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The cost estimator's contract (docs/LIMITS_COST_INSIGHTS_DESIGN.md §3):
 * every figure is an upper-bound estimate at stated assumptions, computed in
 * doubles and rounded only at display; unpriced shares contribute $0 and mark
 * the result incomplete (never renormalized); a `null` cap is unbounded,
 * never $0; token caps bound via ceil, not floor.
 *
 * The worked examples pin LITERAL dollars against the real config/models.json
 * prices on purpose — a price edit must fail here, so the assertions are not
 * recomputed from the pricing table. Period/profile-driven expectations are
 * recomputed from the exported assumptions so the test tracks config edits.
 */

const LIVE: readonly OpenAIModel[] = Object.values(OpenAIModels);
const TYPICAL = EMISSIONS_ASSUMPTIONS.typicalRequest;
const DAYS = COST_ASSUMPTIONS.periodDays;

function pricingOf(id: string) {
  const found = findPricing(id, LIVE);
  if ('excluded' in found) throw new Error(`${id} excluded: ${found.excluded}`);
  return found;
}

const TERRA = 'gpt-5.6-terra';

function baseInput(overrides: Partial<EstimateInput> = {}): EstimateInput {
  return {
    users: 100,
    requestsPerUserPerPeriod: 20 * DAYS.month,
    period: 'month',
    models: TERRA,
    profile: 'typical',
    deployment: 'global',
    ...overrides,
  };
}

// ── Limit cells for the cap-aware examples ──────────────────────────────────

const MODEL_REQUESTS = getLimitDefinition('model.requests')!;
const MODEL_ALLOWED = getLimitDefinition('model.allowed')!;
const CHAT_MESSAGES = getLimitDefinition('chat.messagesPerDay')!;
const TOKENS_DAY = getLimitDefinition('chat.tokensPerDay')!;
const TOKENS_MONTH = getLimitDefinition('chat.tokensPerMonth')!;

const principal: Principal = {
  userId: 'oid-1',
  mail: 'ada@example.org',
  domain: 'example.org',
  attributes: [],
  groupIds: [],
};

function policy(defaults: object[]): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults,
    overrides: [],
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** The conjunctive cells a request on `modelId` must satisfy under `p`. */
function cellsFor(p: LimitsPolicy | null, modelId: string): ResolvedLimit[] {
  const series = OpenAIModels[modelId as keyof typeof OpenAIModels]?.series;
  return [
    ...resolveModelCells(MODEL_ALLOWED, p, principal, modelId, series),
    ...resolveModelCells(MODEL_REQUESTS, p, principal, modelId, series),
    resolveLimit(CHAT_MESSAGES, p, principal),
    resolveLimit(TOKENS_DAY, p, principal),
    resolveLimit(TOKENS_MONTH, p, principal),
  ];
}

// ── Profiles and multipliers ────────────────────────────────────────────────

describe('resolveProfile', () => {
  it('typical is the emissions typicalRequest, so the two surfaces agree', () => {
    expect(resolveProfile('typical')).toEqual({
      ...TYPICAL,
      cachedShare: COST_ASSUMPTIONS.defaultCachedShare,
    });
  });

  it('light and heavy come from config/cost.json', () => {
    expect(resolveProfile('light')).toMatchObject(
      COST_ASSUMPTIONS.profiles.light,
    );
    expect(resolveProfile('heavy')).toMatchObject(
      COST_ASSUMPTIONS.profiles.heavy,
    );
  });

  it('passes a custom profile through, defaulting the cached share', () => {
    expect(resolveProfile({ promptTokens: 10, completionTokens: 5 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedShare: 0,
    });
    expect(
      resolveProfile({
        promptTokens: 10,
        completionTokens: 5,
        cachedShare: 0.3,
      }).cachedShare,
    ).toBe(0.3);
  });

  it('rejects an unknown profile key', () => {
    expect(() => resolveProfile('huge' as never)).toThrow(RangeError);
  });
});

describe('outputMultiplierFor', () => {
  it('applies the dedicated-reasoner multiplier to modelType reasoning', () => {
    expect(outputMultiplierFor(OpenAIModels.o3)).toBe(
      COST_ASSUMPTIONS.dedicatedReasonerOutputMultiplier,
    );
    // Dedicated wins; the two never compound.
    expect(outputMultiplierFor(OpenAIModels.o3, 'high')).toBe(
      COST_ASSUMPTIONS.dedicatedReasonerOutputMultiplier,
    );
  });

  it('applies the high-effort multiplier only to effort-tunable models', () => {
    expect(outputMultiplierFor(OpenAIModels[TERRA], 'high')).toBe(
      COST_ASSUMPTIONS.highEffortOutputMultiplier,
    );
    expect(outputMultiplierFor(OpenAIModels[TERRA], 'medium')).toBe(1);
    expect(outputMultiplierFor(OpenAIModels['gpt-4.1'], 'high')).toBe(1);
  });
});

describe('deploymentMultiplierFor', () => {
  it('returns the configured multiplier for Azure-metered models', () => {
    const { pricing } = pricingOf(TERRA);
    expect(deploymentMultiplierFor(pricing, 'global')).toEqual({
      multiplier: 1,
      applicable: true,
    });
    expect(deploymentMultiplierFor(pricing, 'dataZone')).toEqual({
      multiplier: COST_ASSUMPTIONS.deploymentMultipliers.dataZone,
      applicable: true,
    });
  });

  it('is not applicable to Marketplace or legacy-serverless models', () => {
    expect(
      deploymentMultiplierFor(pricingOf('claude-opus-4-8').pricing, 'regional'),
    ).toEqual({ multiplier: 1, applicable: false });
    expect(
      deploymentMultiplierFor(pricingOf('Ministral-3B').pricing, 'dataZone'),
    ).toEqual({ multiplier: 1, applicable: false });
  });
});

// ── Worked examples: per-request ────────────────────────────────────────────

describe('estimateRequestCost — worked examples', () => {
  it('(1) gpt-5.6-terra typical = $0.008 (input 0.002 + output 0.006)', () => {
    const cost = estimateRequestCost(pricingOf(TERRA).pricing, TYPICAL);
    expect(cost.input).toBeCloseTo(0.002, 10);
    expect(cost.cachedInput).toBe(0);
    expect(cost.output).toBeCloseTo(0.006, 10);
    expect(cost.total).toBeCloseTo(0.008, 10);
    expect(cost.cachedTokens).toBe(0);
    expect(cost.flags).toEqual({
      noCachedRate: false,
      multiplierNotApplicable: false,
      lowConfidence: false,
      alias: false,
    });
  });

  it('(2) terra typical with cachedShare 0.5 = $0.0071', () => {
    const cost = estimateRequestCost(pricingOf(TERRA).pricing, {
      ...TYPICAL,
      cachedShare: 0.5,
    });
    expect(cost.cachedTokens).toBe(500);
    expect(cost.input + cost.cachedInput).toBeCloseTo(0.0011, 10);
    expect(cost.total).toBeCloseTo(0.0071, 10);
    expect(cost.flags.noCachedRate).toBe(false);
  });

  it('(3) terra typical at Data Zone = $0.0088, regional = $0.00968', () => {
    const { pricing } = pricingOf(TERRA);
    expect(
      estimateRequestCost(pricing, { ...TYPICAL, deploymentMultiplier: 1.1 })
        .total,
    ).toBeCloseTo(0.0088, 10);
    expect(
      estimateRequestCost(pricing, { ...TYPICAL, deploymentMultiplier: 1.21 })
        .total,
    ).toBeCloseTo(0.00968, 10);
  });

  it('(4) o3 typical with the reasoner ×3 = $0.014; ×1 = $0.006', () => {
    const { pricing, model } = pricingOf('o3');
    const reasoner = estimateRequestCost(pricing, {
      ...TYPICAL,
      outputMultiplier: outputMultiplierFor(model),
    });
    expect(reasoner.output).toBeCloseTo(0.012, 10);
    expect(reasoner.total).toBeCloseTo(0.014, 10);
    expect(estimateRequestCost(pricing, TYPICAL).total).toBeCloseTo(0.006, 10);
  });

  it('(5) gpt-5-nano typical = $0.00025 → "< $0.01", $0.25 per 1,000', () => {
    const cost = estimateRequestCost(pricingOf('gpt-5-nano').pricing, TYPICAL);
    expect(cost.total).toBeCloseTo(0.00025, 10);
    expect(formatUsdParts(cost.total, 'en-US')).toEqual({
      kind: 'lessThan',
      text: '$0.01',
    });
    expect(perThousandRequestsUsd(cost.total)).toBeCloseTo(0.25, 10);
  });

  it('(6) claude-opus-4-8 heavy = $0.0675 and ignores the deployment multiplier', () => {
    const { pricing } = pricingOf('claude-opus-4-8');
    const heavy = COST_ASSUMPTIONS.profiles.heavy;
    const cost = estimateRequestCost(pricing, heavy);
    expect(cost.input).toBeCloseTo(0.03, 10);
    expect(cost.output).toBeCloseTo(0.0375, 10);
    expect(cost.total).toBeCloseTo(0.0675, 10);
    const regional = estimateRequestCost(pricing, {
      ...heavy,
      deploymentMultiplier: 1.21,
    });
    expect(regional.total).toBeCloseTo(0.0675, 10);
    expect(regional.deploymentMultiplier).toBe(1);
    expect(regional.flags.multiplierNotApplicable).toBe(true);
  });

  it('(7) Llama-3.3-70B with cachedShare 0.5 falls back to the input rate and flags it', () => {
    const cost = estimateRequestCost(
      pricingOf('Llama-3.3-70B-Instruct').pricing,
      { ...TYPICAL, cachedShare: 0.5 },
    );
    expect(cost.input + cost.cachedInput).toBeCloseTo(0.00071, 10);
    expect(cost.output).toBeCloseTo(0.000355, 10);
    expect(cost.total).toBeCloseTo(0.001065, 10);
    expect(cost.flags.noCachedRate).toBe(true);
  });

  it('(9) terra light 400/200 = $0.0032', () => {
    expect(
      estimateRequestCost(pricingOf(TERRA).pricing, resolveProfile('light'))
        .total,
    ).toBeCloseTo(0.0032, 10);
  });

  it('flags lower-confidence and alias pricing', () => {
    expect(
      estimateRequestCost(pricingOf('Ministral-3B').pricing, TYPICAL).flags
        .lowConfidence,
    ).toBe(true);
    expect(
      estimateRequestCost(pricingOf('gpt-chat-latest').pricing, TYPICAL).flags
        .alias,
    ).toBe(true);
  });

  it('scales every component by tool rounds', () => {
    const one = estimateRequestCost(pricingOf(TERRA).pricing, TYPICAL);
    const three = estimateRequestCost(pricingOf(TERRA).pricing, {
      ...TYPICAL,
      toolRounds: 3,
    });
    expect(three.total).toBeCloseTo(one.total * 3, 10);
    expect(three.input).toBeCloseTo(one.input * 3, 10);
    expect(three.toolRounds).toBe(3);
  });

  it('throws RangeError on non-finite, negative, or out-of-range input', () => {
    const { pricing } = pricingOf(TERRA);
    const bad = [
      { promptTokens: -1, completionTokens: 1 },
      { promptTokens: Number.NaN, completionTokens: 1 },
      { promptTokens: 1, completionTokens: Number.POSITIVE_INFINITY },
      { ...TYPICAL, cachedShare: 1.5 },
      { ...TYPICAL, cachedShare: -0.1 },
      { ...TYPICAL, deploymentMultiplier: 0 },
      { ...TYPICAL, outputMultiplier: -2 },
      { ...TYPICAL, toolRounds: 0 },
    ];
    for (const opts of bad) {
      expect(() => estimateRequestCost(pricing, opts)).toThrow(RangeError);
    }
  });
});

describe('per-token rates', () => {
  it('blendedPerTokenUsd is total / counted tokens (rounds cancel out)', () => {
    const { pricing } = pricingOf(TERRA);
    const one = estimateRequestCost(pricing, TYPICAL);
    expect(blendedPerTokenUsd(one)).toBeCloseTo(0.008 / 1500, 12);
    const three = estimateRequestCost(pricing, { ...TYPICAL, toolRounds: 3 });
    expect(blendedPerTokenUsd(three)).toBeCloseTo(blendedPerTokenUsd(one), 12);
  });

  it('outputPerTokenUsd is the pessimistic output rate, multiplier where applicable', () => {
    expect(outputPerTokenUsd(pricingOf(TERRA).pricing)).toBeCloseTo(12e-6, 12);
    expect(outputPerTokenUsd(pricingOf(TERRA).pricing, 1.1)).toBeCloseTo(
      13.2e-6,
      12,
    );
    expect(
      outputPerTokenUsd(pricingOf('claude-opus-4-8').pricing, 1.21),
    ).toBeCloseTo(25e-6, 12);
  });
});

// ── Pricing lookup ──────────────────────────────────────────────────────────

describe('findPricing', () => {
  it('is case-insensitive and prefers the live list', () => {
    const found = findPricing('DEEPSEEK-v4-pro', LIVE);
    expect('excluded' in found).toBe(false);
    if ('excluded' in found) return;
    expect(found.model.id).toBe('DeepSeek-V4-Pro');
    expect(found.servedInRing).toBe(true);
  });

  it('falls back to the static registry for ids this ring does not serve', () => {
    const found = findPricing('grok-4', []);
    expect(found).toMatchObject({ servedInRing: false });
  });

  it('excludes byom, local, and agent ids by prefix, and unknown ids', () => {
    expect(findPricing('byom-abc123-gpt-5.6-terra', LIVE)).toEqual({
      excluded: 'byom',
    });
    expect(findPricing('local-ollama-llama3', LIVE)).toEqual({
      excluded: 'local',
    });
    expect(findPricing('org-comms-bot', LIVE)).toEqual({ excluded: 'agent' });
    expect(findPricing('foundry-abc-agent', LIVE)).toEqual({
      excluded: 'agent',
    });
    expect(findPricing('custom-x', LIVE)).toEqual({ excluded: 'agent' });
    expect(findPricing('gpt-99', LIVE)).toEqual({ excluded: 'unknown-model' });
  });

  it('excludes a served model without pricing and agent-typed models', () => {
    const unpriced = {
      ...OpenAIModels[TERRA],
      id: 'synth-x',
      pricing: undefined,
    };
    expect(findPricing('synth-x', [unpriced])).toEqual({
      excluded: 'no-pricing',
    });
    const agent = {
      ...OpenAIModels[TERRA],
      id: 'bot',
      modelType: 'agent' as const,
    };
    expect(findPricing('bot', [agent])).toEqual({ excluded: 'agent' });
  });
});

// ── Worked examples: spend ──────────────────────────────────────────────────

describe('estimateSpend — worked examples', () => {
  it('(1) 100 users × 20/day on terra for a month = $487.00, annualized $5,844.00', () => {
    const result = estimateSpend(baseInput(), LIVE);
    expect(result.requestsPerUserPerPeriod).toBeCloseTo(608.75, 10);
    expect(result.periodDays).toBe(DAYS.month);
    expect(result.perRequest.total).toBeCloseTo(0.008, 10);
    expect(result.perUserPerPeriod.total).toBeCloseTo(4.87, 10);
    expect(result.totalPerPeriod.total).toBeCloseTo(487, 10);
    expect(result.annualized.total).toBeCloseTo(5844, 10);
    expect(result.incomplete).toBe(false);
    expect(result.excluded).toEqual([]);
    expect(result.perModel).toHaveLength(1);
    expect(result.perModel[0]).toMatchObject({
      modelId: TERRA,
      share: 1,
      servedInRing: true,
    });
  });

  it('(1) the same daily rate per period: week $112, quarter $1,461, year $5,844, day $16', () => {
    const expected: Record<CostPeriod, number> = {
      day: 16,
      week: 112,
      month: 487,
      quarter: 1461,
      year: 5844,
    };
    for (const period of COST_PERIODS) {
      const result = estimateSpend(
        baseInput({ period, requestsPerUserPerPeriod: 20 * DAYS[period] }),
        LIVE,
      );
      expect(result.totalPerPeriod.total).toBeCloseTo(expected[period], 10);
    }
  });

  it('annualized is invariant under the period chosen', () => {
    for (const period of COST_PERIODS) {
      const result = estimateSpend(
        baseInput({ period, requestsPerUserPerPeriod: 20 * DAYS[period] }),
        LIVE,
      );
      expect(result.annualized.total).toBeCloseTo(5844, 10);
    }
  });

  it('breakdowns stay additive through every scaling step', () => {
    const r = estimateSpend(baseInput({ cachedShare: 0.5 }), LIVE);
    for (const b of [
      r.perRequest,
      r.perUserPerPeriod,
      r.totalPerPeriod,
      r.annualized,
    ]) {
      expect(b.input + b.cachedInput + b.output).toBeCloseTo(b.total, 10);
    }
  });

  it('(2)(3) cachedShare and deployment flow through to the spend', () => {
    expect(
      estimateSpend(baseInput({ cachedShare: 0.5 }), LIVE).perRequest.total,
    ).toBeCloseTo(0.0071, 10);
    expect(
      estimateSpend(baseInput({ deployment: 'dataZone' }), LIVE).perRequest
        .total,
    ).toBeCloseTo(0.0088, 10);
  });

  it('(4) o3 gets the reasoner multiplier automatically', () => {
    const r = estimateSpend(baseInput({ models: 'o3' }), LIVE);
    expect(r.perRequest.total).toBeCloseTo(0.014, 10);
    expect(r.perModel[0].perRequest.outputMultiplier).toBe(
      COST_ASSUMPTIONS.dedicatedReasonerOutputMultiplier,
    );
  });

  it('applies the high-effort multiplier on effort-tunable models', () => {
    const r = estimateSpend(baseInput({ reasoningEffort: 'high' }), LIVE);
    // output 0.006 × 2 + input 0.002
    expect(r.perRequest.total).toBeCloseTo(0.014, 10);
  });

  it('(8) 70% terra + 30% gpt-5.4-nano = $0.0058475 per request', () => {
    expect(
      estimateSpend(baseInput({ models: 'gpt-5.4-nano' }), LIVE).perRequest
        .total,
    ).toBeCloseTo(0.000825, 10);
    const r = estimateSpend(
      baseInput({
        models: [
          { modelId: TERRA, share: 70 },
          { modelId: 'gpt-5.4-nano', share: 30 },
        ],
      }),
      LIVE,
    );
    expect(r.perRequest.total).toBeCloseTo(0.0058475, 10);
    expect(r.perModel.map((m) => m.share)).toEqual([0.7, 0.3]);
  });

  it('merges duplicate mix rows into one row with the summed share', () => {
    // Two 50/50 rows naming the same model are one 100% row: the request
    // vector is keyed by modelId, so an unmerged twin would overwrite its
    // sibling's requests (50 instead of 100) while both rows still read the
    // entry — doubling perRequest and making the shares sum to 2.
    const r = estimateSpend(
      baseInput({
        period: 'day',
        users: 1,
        requestsPerUserPerPeriod: 100,
        models: [
          { modelId: TERRA, share: 50 },
          { modelId: TERRA, share: 50 },
        ],
      }),
      LIVE,
    );
    expect(r.requestsPerUserPerPeriod).toBeCloseTo(100, 10);
    expect(r.perRequest.total).toBeCloseTo(0.008, 10);
    expect(r.perUserPerPeriod.total).toBeCloseTo(0.8, 10);
    expect(r.perModel).toHaveLength(1);
    expect(r.perModel[0]).toMatchObject({ modelId: TERRA, share: 1 });
    expect(r.incomplete).toBe(false);
  });

  it('merges duplicate rows case-insensitively, keeping the first spelling', () => {
    // 30 + 40 terra (spelled two ways) + 30 nano → 70/30, exactly example (8).
    const r = estimateSpend(
      baseInput({
        models: [
          { modelId: TERRA, share: 30 },
          { modelId: 'gpt-5.4-nano', share: 30 },
          { modelId: TERRA.toUpperCase(), share: 40 },
        ],
      }),
      LIVE,
    );
    expect(r.perRequest.total).toBeCloseTo(0.0058475, 10);
    expect(r.perModel.map((m) => m.modelId)).toEqual([TERRA, 'gpt-5.4-nano']);
    expect(r.perModel.map((m) => m.share)).toEqual([0.7, 0.3]);
    const shareSum = r.perModel.reduce((acc, m) => acc + m.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);
  });

  it('merges duplicate excluded rows too, so the mix stays one row per id', () => {
    const r = estimateSpend(
      baseInput({
        models: [
          { modelId: TERRA, share: 0.5 },
          { modelId: 'byom-abc-gpt-5.6-terra', share: 0.25 },
          { modelId: 'BYOM-abc-gpt-5.6-terra', share: 0.25 },
        ],
      }),
      LIVE,
    );
    expect(r.excluded).toEqual([
      { modelId: 'byom-abc-gpt-5.6-terra', reason: 'byom' },
    ]);
    // 0.5 × 0.008 — the excluded half contributes $0 and is not renormalized.
    expect(r.perRequest.total).toBeCloseTo(0.004, 10);
    expect(r.perModel[0].share).toBeCloseTo(0.5, 10);
  });

  it('duplicate rows flow through the cap-aware path unchanged', () => {
    const p = policy([{ limitKey: 'chat.messagesPerDay', value: 30 }]);
    const result = estimateSpendWithCaps(
      baseInput({
        period: 'day',
        requestsPerUserPerPeriod: 20,
        models: [
          { modelId: TERRA, share: 1 },
          { modelId: TERRA, share: 1 },
        ],
      }),
      LIVE,
      { [TERRA]: cellsFor(p, TERRA) },
    );
    expect(result.entered.requestsPerUserPerPeriod).toBeCloseTo(20, 10);
    expect(result.entered.perRequest.total).toBeCloseTo(0.008, 10);
    expect(result.capBinding).toBe(false);
    expect(result.ceiling.requestsPerUserPerPeriod).toBeCloseTo(30, 10);
    expect(result.ceiling.perModel).toHaveLength(1);
    // 30 × $0.008 × 100 users
    expect(result.ceiling.totalPerPeriod.total).toBeCloseTo(24, 10);
  });

  it('a mix with an excluded model is incomplete and NOT renormalized', () => {
    const r = estimateSpend(
      baseInput({
        models: [
          { modelId: TERRA, share: 0.7 },
          { modelId: 'byom-abc-gpt-5.6-terra', share: 0.3 },
        ],
      }),
      LIVE,
    );
    expect(r.incomplete).toBe(true);
    expect(r.excluded).toEqual([
      { modelId: 'byom-abc-gpt-5.6-terra', reason: 'byom' },
    ]);
    // 0.7 × 0.008 — the excluded 30% contributes $0, it does not vanish.
    expect(r.perRequest.total).toBeCloseTo(0.0056, 10);
    expect(r.perModel).toHaveLength(1);
    expect(r.perModel[0].share).toBeCloseTo(0.7, 10);
  });

  it('carries every assumption the disclosure line needs', () => {
    const r = estimateSpend(baseInput({ toolRounds: 2 }), LIVE);
    expect(r.assumptions).toEqual({
      assumptionsVersion: COST_ASSUMPTIONS_VERSION,
      pricingAsOf: PRICING_AS_OF,
      pricingAssumptionsVersion: PRICING_ASSUMPTIONS_VERSION,
      emissionsAssumptionsVersion: EMISSIONS_ASSUMPTIONS.assumptionsVersion,
      deployment: 'global',
      profile: { ...TYPICAL, cachedShare: 0 },
      toolRounds: 2,
    });
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('throws RangeError on bad users, requests, shares, or period', () => {
    expect(() => estimateSpend(baseInput({ users: -1 }), LIVE)).toThrow(
      RangeError,
    );
    expect(() =>
      estimateSpend(baseInput({ requestsPerUserPerPeriod: Number.NaN }), LIVE),
    ).toThrow(RangeError);
    expect(() =>
      estimateSpend(
        baseInput({ models: [{ modelId: TERRA, share: -1 }] }),
        LIVE,
      ),
    ).toThrow(RangeError);
    expect(() =>
      estimateSpend(
        baseInput({ models: [{ modelId: TERRA, share: 0 }] }),
        LIVE,
      ),
    ).toThrow(RangeError);
    expect(() => estimateSpend(baseInput({ models: [] }), LIVE)).toThrow(
      RangeError,
    );
    expect(() =>
      estimateSpend(baseInput({ period: 'fortnight' as CostPeriod }), LIVE),
    ).toThrow(RangeError);
    expect(() => estimateSpend(baseInput({ cachedShare: 2 }), LIVE)).toThrow(
      RangeError,
    );
  });
});

// ── Cap-aware bounds ────────────────────────────────────────────────────────

describe('boundRequests', () => {
  const TOKENS = 1500; // typical prompt + completion

  it('(10) is the MIN over conjunctive request cells, named by counter cell', () => {
    const cells = cellsFor(
      policy([
        { limitKey: 'model.requests', modelId: TERRA, value: 50 },
        { limitKey: 'model.requests', series: 'gpt-56', value: 500 },
        { limitKey: 'chat.messagesPerDay', value: 30 },
      ]),
      TERRA,
    );
    expect(boundRequests(cells, TOKENS, 1)).toEqual({
      kind: 'bounded',
      requestsPerUserPerPeriod: 30,
      bindingCell: 'chat.messagesPerDay',
      approximateMonthConversion: false,
    });
    // Scales with the period.
    expect(boundRequests(cells, TOKENS, DAYS.month)).toMatchObject({
      requestsPerUserPerPeriod: 30 * DAYS.month,
    });
  });

  it('(11) token caps bound via ceil, not floor', () => {
    const day = cellsFor(
      policy([{ limitKey: 'chat.tokensPerDay', value: 10_000 }]),
      TERRA,
    );
    // 10,000 / 1,500 = 6.67 → the 7th request starts at 9,000 used.
    expect(boundRequests(day, TOKENS, 1)).toEqual({
      kind: 'bounded',
      requestsPerUserPerPeriod: 7,
      bindingCell: 'chat.tokensPerDay',
      approximateMonthConversion: false,
    });
  });

  it('(11) a calendar-month token cap converts at 30.4375 days and says so', () => {
    const month = cellsFor(
      policy([{ limitKey: 'chat.tokensPerMonth', value: 300_000 }]),
      TERRA,
    );
    const bound = boundRequests(month, TOKENS, 1);
    expect(bound.kind).toBe('bounded');
    if (bound.kind !== 'bounded') return;
    expect(bound.requestsPerUserPerPeriod).toBeCloseTo(200 / DAYS.month, 10);
    expect(bound.bindingCell).toBe('chat.tokensPerMonth');
    expect(bound.approximateMonthConversion).toBe(true);
  });

  it('(12) a 0 counter or model.allowed=false is blocked', () => {
    expect(
      boundRequests(
        cellsFor(
          policy([{ limitKey: 'model.requests', modelId: TERRA, value: 0 }]),
          TERRA,
        ),
        TOKENS,
        1,
      ),
    ).toEqual({ kind: 'blocked' });
    expect(
      boundRequests(
        cellsFor(
          policy([
            { limitKey: 'model.allowed', series: 'gpt-56', value: false },
          ]),
          TERRA,
        ),
        TOKENS,
        1,
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('(13) every cap unlimited is unbounded — never 0', () => {
    expect(boundRequests(cellsFor(null, TERRA), TOKENS, 1)).toEqual({
      kind: 'unbounded',
    });
    expect(boundRequests([], TOKENS, 1)).toEqual({ kind: 'unbounded' });
  });

  it('ignores cells that do not bound requests (booleans, other units)', () => {
    const cells = cellsFor(
      policy([{ limitKey: 'model.allowed', modelId: TERRA, value: true }]),
      TERRA,
    );
    expect(boundRequests(cells, TOKENS, 1)).toEqual({ kind: 'unbounded' });
  });

  it('rejects a non-positive period or tokens-per-request', () => {
    const day = cellsFor(
      policy([{ limitKey: 'chat.tokensPerDay', value: 10_000 }]),
      TERRA,
    );
    expect(() => boundRequests(day, 0, 1)).toThrow(RangeError);
    expect(() => boundRequests(day, TOKENS, 0)).toThrow(RangeError);
  });
});

describe('estimateSpendWithCaps', () => {
  it('(10) entered 20/day under a 30/day message cap: not binding, ceiling $7.31 per user-month', () => {
    const p = policy([
      { limitKey: 'model.requests', modelId: TERRA, value: 50 },
      { limitKey: 'model.requests', series: 'gpt-56', value: 500 },
      { limitKey: 'chat.messagesPerDay', value: 30 },
    ]);
    const result = estimateSpendWithCaps(baseInput(), LIVE, {
      [TERRA]: cellsFor(p, TERRA),
    });
    expect(result.capBinding).toBe(false);
    expect(result.bindingCells).toEqual(['chat.messagesPerDay']);
    expect(result.entered.totalPerPeriod.total).toBeCloseTo(487, 10);
    expect(result.ceiling.requestsPerUserPerPeriod).toBeCloseTo(
      30 * DAYS.month,
      10,
    );
    expect(result.ceiling.perUserPerPeriod.total).toBeCloseTo(7.305, 10);
    expect(
      formatUsdParts(result.ceiling.perUserPerPeriod.total, 'en-US'),
    ).toEqual({ kind: 'amount', text: '$7.31' });
    expect(result.ceiling.totalPerPeriod.total).toBeCloseTo(730.5, 10);
  });

  it('(10) entered 40/day over the same cap: binding, ceiling stays at the cap', () => {
    const p = policy([{ limitKey: 'chat.messagesPerDay', value: 30 }]);
    const result = estimateSpendWithCaps(
      baseInput({ requestsPerUserPerPeriod: 40 * DAYS.month }),
      LIVE,
      { [TERRA]: cellsFor(p, TERRA) },
    );
    expect(result.capBinding).toBe(true);
    expect(result.bindingCells).toEqual(['chat.messagesPerDay']);
    expect(result.ceiling.totalPerPeriod.total).toBeCloseTo(730.5, 10);
  });

  it('(11) token caps bind at ceil(limit / tokens per request)', () => {
    const p = policy([{ limitKey: 'chat.tokensPerDay', value: 10_000 }]);
    const result = estimateSpendWithCaps(
      baseInput({ period: 'day', requestsPerUserPerPeriod: 20 }),
      LIVE,
      { [TERRA]: cellsFor(p, TERRA) },
    );
    expect(result.capBinding).toBe(true);
    expect(result.bindingCells).toEqual(['chat.tokensPerDay']);
    expect(result.ceiling.requestsPerUserPerPeriod).toBe(7);
    expect(result.ceiling.perUserPerPeriod.total).toBeCloseTo(7 * 0.008, 10);
  });

  it('(12) a blocked model spends $0.00', () => {
    const p = policy([
      { limitKey: 'model.allowed', modelId: TERRA, value: false },
    ]);
    const result = estimateSpendWithCaps(baseInput(), LIVE, {
      [TERRA]: cellsFor(p, TERRA),
    });
    expect(result.capBinding).toBe(true);
    expect(result.bindingCells).toEqual([`model:${TERRA}.allowed`]);
    expect(result.ceiling.totalPerPeriod.total).toBe(0);
    expect(result.ceiling.requestsPerUserPerPeriod).toBe(0);
    // The plain estimate is untouched.
    expect(result.entered.totalPerPeriod.total).toBeCloseTo(487, 10);
  });

  it('(13) with every cap unlimited the ceiling IS the entered estimate', () => {
    const result = estimateSpendWithCaps(baseInput(), LIVE, {
      [TERRA]: cellsFor(null, TERRA),
    });
    expect(result.capBinding).toBe(false);
    expect(result.bindingCells).toEqual([]);
    expect(result.ceiling).toBe(result.entered);
  });

  it('a model with no cells at all is unbounded', () => {
    const result = estimateSpendWithCaps(baseInput(), LIVE, {});
    expect(result.capBinding).toBe(false);
    expect(result.ceiling).toBe(result.entered);
  });

  it('scales a family envelope over its members proportionally, never summing', () => {
    const p = policy([
      { limitKey: 'model.requests', series: 'gpt-56', value: 100 },
    ]);
    const cells = {
      [TERRA]: cellsFor(p, TERRA),
      'gpt-5.6-luna': cellsFor(p, 'gpt-5.6-luna'),
    };
    const input = baseInput({
      period: 'day',
      users: 1,
      requestsPerUserPerPeriod: 160,
      models: [
        { modelId: TERRA, share: 1 },
        { modelId: 'gpt-5.6-luna', share: 1 },
      ],
    });
    const result = estimateSpendWithCaps(input, LIVE, cells);
    // 80 + 80 entered > 100 family envelope → binding.
    expect(result.capBinding).toBe(true);
    expect(result.bindingCells).toEqual(['family:gpt-56.requests']);
    // At the cap each member alone could reach 100, but the envelope holds
    // the SUM at 100 → 50 + 50, not 100 + 100.
    expect(result.ceiling.requestsPerUserPerPeriod).toBeCloseTo(100, 10);
    expect(result.ceiling.perModel.map((m) => m.share)).toEqual([0.5, 0.5]);
    // 50 × $0.008 (terra) + 50 × $0.0008 (luna)
    expect(result.ceiling.perUserPerPeriod.total).toBeCloseTo(0.44, 10);
  });

  it('a model sub-cap plus a family envelope: each model at its own cap, sum within the envelope', () => {
    const p = policy([
      { limitKey: 'model.requests', modelId: TERRA, value: 10 },
      { limitKey: 'model.requests', series: 'gpt-56', value: 100 },
    ]);
    const cells = {
      [TERRA]: cellsFor(p, TERRA),
      'gpt-5.6-luna': cellsFor(p, 'gpt-5.6-luna'),
    };
    const result = estimateSpendWithCaps(
      baseInput({
        period: 'day',
        users: 1,
        requestsPerUserPerPeriod: 10,
        models: [
          { modelId: TERRA, share: 1 },
          { modelId: 'gpt-5.6-luna', share: 1 },
        ],
      }),
      LIVE,
      cells,
    );
    expect(result.capBinding).toBe(false);
    // terra → 10 (own cap), luna → 100 (family) → 110 > 100 → scaled to 100.
    expect(result.ceiling.requestsPerUserPerPeriod).toBeCloseTo(100, 10);
    expect(result.bindingCells).toEqual(
      expect.arrayContaining([
        `model:${TERRA}.requests`,
        'family:gpt-56.requests',
      ]),
    );
  });

  it('leaves excluded models out of the cap arithmetic but keeps them reported', () => {
    const p = policy([{ limitKey: 'chat.messagesPerDay', value: 30 }]);
    const result = estimateSpendWithCaps(
      baseInput({
        period: 'day',
        requestsPerUserPerPeriod: 20,
        models: [
          { modelId: TERRA, share: 1 },
          { modelId: 'byom-x-y', share: 1 },
        ],
      }),
      LIVE,
      { [TERRA]: cellsFor(p, TERRA) },
    );
    expect(result.entered.incomplete).toBe(true);
    expect(result.ceiling.incomplete).toBe(true);
    expect(result.ceiling.excluded).toEqual([
      { modelId: 'byom-x-y', reason: 'byom' },
    ]);
    // Terra alone reaches the 30/day cap: 30 × $0.008 × 100 users.
    expect(result.ceiling.totalPerPeriod.total).toBeCloseTo(24, 10);
  });

  it('looks cells up case-insensitively, like the resolver', () => {
    const p = policy([{ limitKey: 'chat.messagesPerDay', value: 30 }]);
    const result = estimateSpendWithCaps(baseInput(), LIVE, {
      'GPT-5.6-TERRA': cellsFor(p, TERRA),
    });
    expect(result.bindingCells).toEqual(['chat.messagesPerDay']);
  });
});

// ── Display ─────────────────────────────────────────────────────────────────

describe('formatUsdParts', () => {
  it('buckets exactly zero, sub-cent, and amounts', () => {
    expect(formatUsdParts(0, 'en-US')).toEqual({ kind: 'zero' });
    expect(formatUsdParts(0.004999, 'en-US')).toEqual({
      kind: 'lessThan',
      text: '$0.01',
    });
    expect(formatUsdParts(0.005, 'en-US')).toEqual({
      kind: 'amount',
      text: '$0.01',
    });
  });

  it('groups thousands and rounds half away from zero', () => {
    expect(formatUsdParts(1234.5, 'en-US')).toEqual({
      kind: 'amount',
      text: '$1,234.50',
    });
    expect(formatUsdParts(7.305, 'en-US')).toEqual({
      kind: 'amount',
      text: '$7.31',
    });
    expect(formatUsdParts(4.87, 'en-US')).toEqual({
      kind: 'amount',
      text: '$4.87',
    });
  });

  it('respects the locale and survives an invalid one', () => {
    expect(formatUsdParts(1234.5, 'de-DE').kind).toBe('amount');
    expect(formatUsdParts(1234.5, 'de-DE')).not.toEqual(
      formatUsdParts(1234.5, 'en-US'),
    );
    expect(formatUsdParts(1234.5, 'not a locale')).toEqual({
      kind: 'amount',
      text: '$1,234.50',
    });
  });

  it('throws RangeError on negative or non-finite money', () => {
    expect(() => formatUsdParts(-1, 'en-US')).toThrow(RangeError);
    expect(() => formatUsdParts(Number.NaN, 'en-US')).toThrow(RangeError);
    expect(() => perThousandRequestsUsd(-0.01)).toThrow(RangeError);
  });
});

// ── Config validation ───────────────────────────────────────────────────────

describe('config/cost.json validation', () => {
  afterEach(() => {
    vi.doUnmock('@/config/cost.json');
    vi.resetModules();
  });

  it('exposes the assumption set and derives month/quarter from the year', () => {
    expect(COST_ASSUMPTIONS_VERSION).toBe(COST_ASSUMPTIONS.assumptionsVersion);
    expect(DAYS.month).toBeCloseTo(DAYS.year / 12, 10);
    expect(DAYS.quarter).toBeCloseTo(DAYS.year / 4, 10);
    expect(COST_ASSUMPTIONS.defaultCachedShare).toBe(0);
  });

  it('throws at module load with a [cost] prefix when the file is malformed', async () => {
    vi.doMock('@/config/cost.json', () => ({
      default: { assumptionsVersion: '' },
    }));
    vi.resetModules();
    await expect(import('@/lib/utils/shared/costEstimator')).rejects.toThrow(
      /\[cost\] Invalid config\/cost\.json/,
    );
  });
});
