/**
 * Cost estimation from list-price token rates — the pure math behind the
 * limits admin's cost insights and estimator (docs/LIMITS_COST_INSIGHTS_DESIGN.md §3).
 *
 * Pure + shared (no server-only, React, or feature-flag imports): the limits
 * admin renders these figures client-side from the model list it already
 * holds, and the server may stamp `estimatedCostUsd` on token-usage metrics
 * with the same arithmetic. Every result carries `assumptions` so a displayed
 * number is traceable to the price pull and assumption set that produced it.
 *
 * ── What the numbers are, and are not ─────────────────────────────────────
 * Every figure is an UPPER-BOUND ESTIMATE AT STATED ASSUMPTIONS, never a bill:
 *  - Prices are list rates for Global Standard deployments as of
 *    config/models.json `pricingAsOf`; Data Zone ≈1.1× and regional ≈1.21×
 *    are explicit inputs (config/cost.json deploymentMultipliers) because the
 *    deployment SKU is not on the model object. Marketplace-billed (claude-*)
 *    and legacy-serverless models are billed at their own rates, so the
 *    multiplier is NOT applied to them (`multiplierNotApplicable`).
 *  - A deployment name is not the billed model (the EU `gpt-5.2` deployment
 *    serves 5.5); pricing is keyed by catalog id.
 *  - Reasoning / thinking tokens are billed as output but are invisible in a
 *    token profile. Dedicated reasoners (modelType 'reasoning') get
 *    `dedicatedReasonerOutputMultiplier`, `reasoningEffort: 'high'` on a
 *    tunable model gets `highEffortOutputMultiplier` — uncalibrated constants
 *    chosen to keep the bound an upper bound.
 *  - One counted request (message) can be up to `feature.mcp.roundsPerRequest`
 *    model calls; `toolRounds` scales every component and defaults to 1.
 *  - No cached-token telemetry exists, so `cachedShare` defaults to 0 (the
 *    pessimistic case); a nonzero share is an optimistic scenario and
 *    cache-WRITE premiums are not modeled at all.
 *  - Period lengths derive from a 365.25-day year (month = year/12, quarter
 *    = year/4) so `annualized` is invariant under the period chosen; calendar
 *    days, because a per-day cap is consumable every calendar day. The
 *    limits system's `month` window is a CALENDAR month — conversions from
 *    it are flagged `approximateMonthConversion`.
 *
 * Arithmetic is done in doubles and rounded ONLY at display (formatUsdParts):
 * rounding a per-request figure to cents before multiplying by 608.75
 * requests turns $0.008 into $0.01 — a 25% error.
 */
import type { ResolvedLimit } from '@/lib/services/limits/resolver';
import { counterCellName } from '@/lib/services/limits/resolver';

import { ASSUMPTIONS_VERSION as EMISSIONS_ASSUMPTIONS_VERSION } from '@/lib/utils/shared/emissions';
import { EMISSIONS_ASSUMPTIONS } from '@/lib/utils/shared/emissions';

import {
  OpenAIModel,
  OpenAIModels,
  PRICING_ASSUMPTIONS_VERSION,
  PRICING_AS_OF,
} from '@/types/openai';

import costConfig from '@/config/cost.json';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Assumptions (config/cost.json), validated at module load
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  promptTokens: z.number().positive(),
  completionTokens: z.number().positive(),
});

const costAssumptionsSchema = z.object({
  assumptionsVersion: z.string().min(1),
  periodDays: z.object({
    day: z.number().positive(),
    week: z.number().positive(),
    month: z.number().positive(),
    quarter: z.number().positive(),
    year: z.number().positive(),
  }),
  deploymentMultipliers: z.object({
    global: z.number().positive(),
    dataZone: z.number().positive(),
    regional: z.number().positive(),
  }),
  profiles: z.object({
    light: profileSchema,
    heavy: profileSchema,
  }),
  dedicatedReasonerOutputMultiplier: z.number().min(1),
  highEffortOutputMultiplier: z.number().min(1),
  defaultCachedShare: z.number().min(0).max(1),
  defaultToolRounds: z.number().int().min(1),
});

export type CostAssumptions = z.infer<typeof costAssumptionsSchema>;

/** Validated at module load so a malformed edit fails fast (emissions.json pattern). */
export const COST_ASSUMPTIONS: CostAssumptions = (() => {
  const parsed = costAssumptionsSchema.safeParse(costConfig);
  if (!parsed.success) {
    throw new Error(`[cost] Invalid config/cost.json: ${parsed.error.message}`);
  }
  return parsed.data;
})();

/** The assumption-set identifier, for display traceability. */
export const COST_ASSUMPTIONS_VERSION = COST_ASSUMPTIONS.assumptionsVersion;

// ---------------------------------------------------------------------------
// Types (the §3 contract)
// ---------------------------------------------------------------------------

export type CostPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const COST_PERIODS: readonly CostPeriod[] = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;

export type Deployment = 'global' | 'dataZone' | 'regional';
export const DEPLOYMENTS: readonly Deployment[] = [
  'global',
  'dataZone',
  'regional',
] as const;

export type ProfileKey = 'light' | 'typical' | 'heavy';
export const PROFILE_KEYS: readonly ProfileKey[] = [
  'light',
  'typical',
  'heavy',
] as const;

export interface CustomProfile {
  promptTokens: number;
  completionTokens: number;
  /** Fraction of prompt tokens served from the prompt cache, 0..1. */
  cachedShare?: number;
}

export type RequestProfile = ProfileKey | CustomProfile;

export type ModelPricing = NonNullable<OpenAIModel['pricing']>;

/** USD. Components are additive: total = input + cachedInput + output. */
export interface CostBreakdown {
  input: number;
  cachedInput: number;
  output: number;
  total: number;
}

export interface PerRequestCost extends CostBreakdown {
  promptTokens: number;
  completionTokens: number;
  /** round(promptTokens × cachedShare) — the part billed at the cached rate. */
  cachedTokens: number;
  /** The multiplier actually applied (1 when not applicable). */
  deploymentMultiplier: number;
  outputMultiplier: number;
  toolRounds: number;
  flags: {
    /** cachedShare > 0 but the model publishes no cached rate; full input rate used. */
    noCachedRate: boolean;
    /** Marketplace / legacy-serverless billing: deployment multiplier forced to 1. */
    multiplierNotApplicable: boolean;
    /** `pricing.confidence === 'serverless-legacy'`. */
    lowConfidence: boolean;
    /** `pricing.alias === true` — the rate follows whatever the alias routes to. */
    alias: boolean;
  };
}

export type ExclusionReason =
  | 'no-pricing'
  | 'byom'
  | 'local'
  | 'agent'
  | 'unknown-model';

export type PricingLookup =
  | { model: OpenAIModel; pricing: ModelPricing; servedInRing: boolean }
  | { excluded: ExclusionReason };

export interface EstimateInput {
  users: number;
  requestsPerUserPerPeriod: number;
  period: CostPeriod;
  /** A single model id, or a mix. Shares are weights (any positive scale). */
  models: string | Array<{ modelId: string; share: number }>;
  profile: RequestProfile;
  deployment: Deployment;
  /** Overrides the profile's cached share. */
  cachedShare?: number;
  /** Model calls per counted request; default config `defaultToolRounds`. */
  toolRounds?: number;
  /** 'high' applies `highEffortOutputMultiplier` on effort-tunable models. */
  reasoningEffort?: string;
}

export interface EstimateAssumptions {
  assumptionsVersion: string;
  pricingAsOf: string;
  pricingAssumptionsVersion: string;
  emissionsAssumptionsVersion: string;
  deployment: Deployment;
  profile: Required<CustomProfile>;
  toolRounds: number;
}

export interface EstimatePerModel {
  modelId: string;
  /** NORMALIZED share of requests (sums to 1 over priced + excluded models). */
  share: number;
  perRequest: PerRequestCost;
  servedInRing: boolean;
}

export interface EstimateResult {
  /** Mix-weighted cost of one request (excluded shares contribute 0). */
  perRequest: CostBreakdown;
  perUserPerPeriod: CostBreakdown;
  totalPerPeriod: CostBreakdown;
  annualized: CostBreakdown;
  requestsPerUserPerPeriod: number;
  periodDays: number;
  perModel: EstimatePerModel[];
  excluded: Array<{ modelId: string; reason: ExclusionReason }>;
  /** True when any share was unpriced — the totals understate spend. */
  incomplete: boolean;
  assumptions: EstimateAssumptions;
}

export type RequestBound =
  | {
      kind: 'bounded';
      requestsPerUserPerPeriod: number;
      /** counterCellName of the cell that produced the minimum. */
      bindingCell: string;
      /** The binding cell has a calendar-month window, converted at 30.4375 days. */
      approximateMonthConversion: boolean;
    }
  | { kind: 'unbounded' }
  | { kind: 'blocked' };

export interface EstimateWithCaps {
  /** The plain estimate at the entered requests. */
  entered: EstimateResult;
  /**
   * Spend if every user reached every cap that applies (unbounded cells keep
   * the entered requests). Equals `entered` when nothing binds.
   */
  ceiling: EstimateResult;
  /** The entered requests exceed what the caps allow. */
  capBinding: boolean;
  /** counterCellNames of the cells that determine `ceiling`. */
  bindingCells: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertFiniteNonNegative(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `[cost] ${name} must be a finite non-negative number (got ${String(value)})`,
    );
  }
}

function assertFinitePositive(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `[cost] ${name} must be a finite positive number (got ${String(value)})`,
    );
  }
}

function assertShare(value: number, name: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(
      `[cost] ${name} must be within [0, 1] (got ${String(value)})`,
    );
  }
}

function zeroBreakdown(): CostBreakdown {
  return { input: 0, cachedInput: 0, output: 0, total: 0 };
}

function scaleBreakdown(b: CostBreakdown, factor: number): CostBreakdown {
  return {
    input: b.input * factor,
    cachedInput: b.cachedInput * factor,
    output: b.output * factor,
    total: b.total * factor,
  };
}

function addBreakdown(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

// ---------------------------------------------------------------------------
// Profiles and multipliers
// ---------------------------------------------------------------------------

/**
 * Resolves a profile key or custom profile to concrete token counts.
 * `typical` is EMISSIONS_ASSUMPTIONS.typicalRequest so the cost figure and
 * the CO2 tooltip describe the same request. A missing cachedShare takes the
 * configured default (0 — the upper bound).
 */
export function resolveProfile(
  profile: RequestProfile,
): Required<CustomProfile> {
  const cachedShare = COST_ASSUMPTIONS.defaultCachedShare;
  if (typeof profile === 'string') {
    if (profile === 'typical') {
      return { ...EMISSIONS_ASSUMPTIONS.typicalRequest, cachedShare };
    }
    const preset = COST_ASSUMPTIONS.profiles[profile as 'light' | 'heavy'];
    if (!preset) {
      throw new RangeError(`[cost] Unknown request profile "${profile}"`);
    }
    return { ...preset, cachedShare };
  }
  return {
    promptTokens: profile.promptTokens,
    completionTokens: profile.completionTokens,
    cachedShare: profile.cachedShare ?? cachedShare,
  };
}

/**
 * Output-token multiplier standing in for invisible reasoning tokens:
 * dedicated reasoners always think (×dedicatedReasonerOutputMultiplier);
 * an effort-tunable model at 'high' gets ×highEffortOutputMultiplier;
 * everything else ×1. The two do not compound.
 */
export function outputMultiplierFor(
  model: Pick<OpenAIModel, 'modelType' | 'supportsReasoningEffort'>,
  effort?: 'high' | string,
): number {
  if (model.modelType === 'reasoning') {
    return COST_ASSUMPTIONS.dedicatedReasonerOutputMultiplier;
  }
  if (model.supportsReasoningEffort === true && effort === 'high') {
    return COST_ASSUMPTIONS.highEffortOutputMultiplier;
  }
  return 1;
}

/** Marketplace and legacy-serverless rates are not Azure deployment meters. */
function multiplierApplies(pricing: ModelPricing): boolean {
  return (
    pricing.billing !== 'marketplace' &&
    pricing.confidence !== 'serverless-legacy'
  );
}

/**
 * The deployment-type multiplier for a model. `applicable: false` (and ×1)
 * for Marketplace-billed and legacy-serverless models, whose rates are not
 * Global Standard meters.
 */
export function deploymentMultiplierFor(
  pricing: ModelPricing,
  deployment: Deployment,
): { multiplier: number; applicable: boolean } {
  const configured = COST_ASSUMPTIONS.deploymentMultipliers[deployment];
  if (configured === undefined) {
    throw new RangeError(`[cost] Unknown deployment "${String(deployment)}"`);
  }
  if (!multiplierApplies(pricing)) return { multiplier: 1, applicable: false };
  return { multiplier: configured, applicable: true };
}

// ---------------------------------------------------------------------------
// Per-request cost
// ---------------------------------------------------------------------------

export interface RequestCostOptions {
  promptTokens: number;
  completionTokens: number;
  /** 0..1; default config `defaultCachedShare`. */
  cachedShare?: number;
  /** Default 1. Forced to 1 (flagged) when the model's billing is not an Azure meter. */
  deploymentMultiplier?: number;
  /** Default 1. See outputMultiplierFor. */
  outputMultiplier?: number;
  /** Default config `defaultToolRounds`. */
  toolRounds?: number;
}

/**
 * USD for one counted request:
 *   cachedTokens = round(prompt × cachedShare)
 *   input        = (prompt − cached) × inputPer1M / 1e6
 *   cachedInput  = cached × (cachedInputPer1M ?? inputPer1M) / 1e6
 *   output       = completion × outputMultiplier × outputPer1M / 1e6
 * each × deploymentMultiplier × toolRounds.
 *
 * Throws RangeError on non-finite/negative token counts, non-positive
 * multipliers or rounds, or cachedShare outside [0, 1].
 */
export function estimateRequestCost(
  pricing: ModelPricing,
  opts: RequestCostOptions,
): PerRequestCost {
  const cachedShare = opts.cachedShare ?? COST_ASSUMPTIONS.defaultCachedShare;
  const requestedMultiplier = opts.deploymentMultiplier ?? 1;
  const outputMultiplier = opts.outputMultiplier ?? 1;
  const toolRounds = opts.toolRounds ?? COST_ASSUMPTIONS.defaultToolRounds;

  assertFiniteNonNegative(opts.promptTokens, 'promptTokens');
  assertFiniteNonNegative(opts.completionTokens, 'completionTokens');
  assertShare(cachedShare, 'cachedShare');
  assertFinitePositive(requestedMultiplier, 'deploymentMultiplier');
  assertFinitePositive(outputMultiplier, 'outputMultiplier');
  assertFinitePositive(toolRounds, 'toolRounds');
  assertFiniteNonNegative(pricing.inputPer1M, 'pricing.inputPer1M');
  assertFiniteNonNegative(pricing.outputPer1M, 'pricing.outputPer1M');

  const applicable = multiplierApplies(pricing);
  const deploymentMultiplier = applicable ? requestedMultiplier : 1;

  const cachedTokens = Math.round(opts.promptTokens * cachedShare);
  const freshTokens = opts.promptTokens - cachedTokens;
  const noCachedRate =
    cachedShare > 0 && pricing.cachedInputPer1M === undefined;
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;

  const factor = deploymentMultiplier * toolRounds;
  const input = ((freshTokens * pricing.inputPer1M) / 1e6) * factor;
  const cachedInput = ((cachedTokens * cachedRate) / 1e6) * factor;
  const output =
    ((opts.completionTokens * outputMultiplier * pricing.outputPer1M) / 1e6) *
    factor;

  return {
    input,
    cachedInput,
    output,
    total: input + cachedInput + output,
    promptTokens: opts.promptTokens,
    completionTokens: opts.completionTokens,
    cachedTokens,
    deploymentMultiplier,
    outputMultiplier,
    toolRounds,
    flags: {
      noCachedRate,
      multiplierNotApplicable: !applicable,
      lowConfidence: pricing.confidence === 'serverless-legacy',
      alias: pricing.alias === true,
    },
  };
}

/**
 * The tokens the debit path counts for one request at this cost: every
 * round's prompt + (multiplied) completion tokens, cached or not.
 */
export function countedTokensPerRequest(
  perRequest: Pick<
    PerRequestCost,
    'promptTokens' | 'completionTokens' | 'outputMultiplier' | 'toolRounds'
  >,
): number {
  return (
    (perRequest.promptTokens +
      perRequest.completionTokens * perRequest.outputMultiplier) *
    perRequest.toolRounds
  );
}

/**
 * USD per COUNTED token — total / counted tokens — for turning a token cap
 * into spend. Includes tool rounds in the denominator because the debit path
 * counts every round's tokens (so the rate does not scale with rounds).
 */
export function blendedPerTokenUsd(perRequest: PerRequestCost): number {
  const tokens = countedTokensPerRequest(perRequest);
  if (tokens <= 0) return 0;
  return perRequest.total / tokens;
}

/**
 * The pessimistic per-token rate: every token billed as output. The same
 * applicability rule as deploymentMultiplierFor (Marketplace / legacy → ×1).
 */
export function outputPerTokenUsd(
  pricing: ModelPricing,
  deploymentMultiplier = 1,
): number {
  assertFinitePositive(deploymentMultiplier, 'deploymentMultiplier');
  const multiplier = multiplierApplies(pricing) ? deploymentMultiplier : 1;
  return (pricing.outputPer1M / 1e6) * multiplier;
}

// ---------------------------------------------------------------------------
// Pricing lookup
// ---------------------------------------------------------------------------

/**
 * Ids that are never org-priced by construction: user-billed BYO sources,
 * browser-direct local runtimes, and agent wrappers (which carry a BASE
 * model's pricing by accident, not truth — see agentAttachment.ts).
 */
export function exclusionForModelId(modelId: string): ExclusionReason | null {
  const id = modelId.toLowerCase();
  if (id.startsWith('byom-')) return 'byom';
  if (id.startsWith('local-')) return 'local';
  if (
    id.startsWith('org-') ||
    id.startsWith('foundry-') ||
    id.startsWith('custom-')
  ) {
    return 'agent';
  }
  return null;
}

/** Exclusion from the model OBJECT's flags (a found model can still be unpriceable). */
export function exclusionForModel(model: OpenAIModel): ExclusionReason | null {
  const byId = exclusionForModelId(model.id ?? '');
  if (byId) return byId;
  if (model.isLocalModel === true) return 'local';
  if (model.isCustomSourceModel === true) return 'byom';
  if (model.modelType === 'agent' || model.isOrganizationAgent === true) {
    return 'agent';
  }
  if (!model.pricing) return 'no-pricing';
  return null;
}

function findModelCaseInsensitive(
  modelId: string,
  models: Iterable<OpenAIModel>,
): OpenAIModel | undefined {
  const wanted = modelId.toLowerCase();
  for (const model of models) {
    if (model.id?.toLowerCase() === wanted) return model;
  }
  return undefined;
}

/**
 * Case-insensitive pricing lookup: the live (ring-served) list first, then
 * the static OpenAIModels registry — stored limits can name ids this ring
 * does not serve (`servedInRing: false`). byom-/local-/org-/foundry-/custom-
 * ids are excluded up front.
 */
export function findPricing(
  modelId: string,
  liveModels: readonly OpenAIModel[],
): PricingLookup {
  const byId = exclusionForModelId(modelId);
  if (byId) return { excluded: byId };

  const live = findModelCaseInsensitive(modelId, liveModels);
  const model =
    live ?? findModelCaseInsensitive(modelId, Object.values(OpenAIModels));
  if (!model) return { excluded: 'unknown-model' };

  const reason = exclusionForModel(model);
  if (reason) return { excluded: reason };
  return {
    model,
    pricing: model.pricing as ModelPricing,
    servedInRing: live !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Spend estimate
// ---------------------------------------------------------------------------

interface PricedMixModel {
  modelId: string;
  /** Raw share as entered. */
  share: number;
  perRequest: PerRequestCost;
  servedInRing: boolean;
}

interface NormalizedMix {
  priced: PricedMixModel[];
  excluded: Array<{ modelId: string; share: number; reason: ExclusionReason }>;
  /** Σ shares over priced AND excluded models. */
  shareTotal: number;
}

/**
 * Validates the mix and MERGES rows that name the same model (case-
 * insensitively, like findPricing and the resolver) by summing their shares,
 * keeping the first spelling. The request vectors downstream are Maps keyed
 * by modelId, so a repeated row would overwrite its twin's requests while
 * both rows still read the entry — halving requestsPerUserPerPeriod and
 * doubling perRequest. Merging keeps the key unique per priced/excluded row
 * and perModel shares summing to 1; not throwing because the calculator
 * already dedupes and this module is the public §3 contract.
 */
function normalizeModels(
  models: EstimateInput['models'],
): Array<{ modelId: string; share: number }> {
  const list =
    typeof models === 'string' ? [{ modelId: models, share: 1 }] : models;
  if (!Array.isArray(list) || list.length === 0) {
    throw new RangeError('[cost] models must name at least one model');
  }
  let sum = 0;
  const merged = new Map<string, { modelId: string; share: number }>();
  for (const entry of list) {
    if (!entry || typeof entry.modelId !== 'string' || !entry.modelId) {
      throw new RangeError('[cost] every mix row needs a modelId');
    }
    assertFiniteNonNegative(entry.share, `share of ${entry.modelId}`);
    sum += entry.share;
    const key = entry.modelId.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.share += entry.share;
    } else {
      merged.set(key, { modelId: entry.modelId, share: entry.share });
    }
  }
  if (sum <= 0) throw new RangeError('[cost] mix shares must sum to > 0');
  return [...merged.values()];
}

function priceMix(
  input: EstimateInput,
  liveModels: readonly OpenAIModel[],
  profile: Required<CustomProfile>,
  toolRounds: number,
): NormalizedMix {
  const rows = normalizeModels(input.models);
  const priced: PricedMixModel[] = [];
  const excluded: NormalizedMix['excluded'] = [];
  let shareTotal = 0;
  for (const row of rows) {
    shareTotal += row.share;
    const found = findPricing(row.modelId, liveModels);
    if ('excluded' in found) {
      excluded.push({
        modelId: row.modelId,
        share: row.share,
        reason: found.excluded,
      });
      continue;
    }
    const { multiplier } = deploymentMultiplierFor(
      found.pricing,
      input.deployment,
    );
    priced.push({
      modelId: row.modelId,
      share: row.share,
      servedInRing: found.servedInRing,
      perRequest: estimateRequestCost(found.pricing, {
        promptTokens: profile.promptTokens,
        completionTokens: profile.completionTokens,
        cachedShare: profile.cachedShare,
        deploymentMultiplier: multiplier,
        outputMultiplier: outputMultiplierFor(
          found.model,
          input.reasoningEffort,
        ),
        toolRounds,
      }),
    });
  }
  return { priced, excluded, shareTotal };
}

/**
 * Assembles an EstimateResult from per-model REQUEST counts (per user per
 * period). Excluded models keep their request count so shares stay honest
 * and `incomplete` is set; they contribute $0.
 */
function assemble(
  mix: NormalizedMix,
  requestsByModel: Map<string, number>,
  fallbackShareTotal: number,
  input: EstimateInput,
  assumptions: EstimateAssumptions,
): EstimateResult {
  const periodDays = COST_ASSUMPTIONS.periodDays[input.period];
  let requestsPerUser = 0;
  for (const value of requestsByModel.values()) requestsPerUser += value;

  let perUser = zeroBreakdown();
  const perModel: EstimatePerModel[] = mix.priced.map((m) => {
    const requests = requestsByModel.get(m.modelId) ?? 0;
    perUser = addBreakdown(perUser, scaleBreakdown(m.perRequest, requests));
    return {
      modelId: m.modelId,
      share:
        requestsPerUser > 0
          ? requests / requestsPerUser
          : m.share / fallbackShareTotal,
      perRequest: m.perRequest,
      servedInRing: m.servedInRing,
    };
  });

  const perRequest =
    requestsPerUser > 0
      ? scaleBreakdown(perUser, 1 / requestsPerUser)
      : // No requests at all (e.g. everything blocked): report the mix rate
        // so the UI can still show "per request" without dividing by zero.
        mix.priced.reduce(
          (acc, m) =>
            addBreakdown(
              acc,
              scaleBreakdown(m.perRequest, m.share / fallbackShareTotal),
            ),
          zeroBreakdown(),
        );
  const totalPerPeriod = scaleBreakdown(perUser, input.users);
  const annualized = scaleBreakdown(
    totalPerPeriod,
    COST_ASSUMPTIONS.periodDays.year / periodDays,
  );

  return {
    perRequest,
    perUserPerPeriod: perUser,
    totalPerPeriod,
    annualized,
    requestsPerUserPerPeriod: requestsPerUser,
    periodDays,
    perModel,
    excluded: mix.excluded.map(({ modelId, reason }) => ({ modelId, reason })),
    incomplete: mix.excluded.length > 0,
    assumptions,
  };
}

function validateEstimateInput(input: EstimateInput): void {
  assertFiniteNonNegative(input.users, 'users');
  assertFiniteNonNegative(
    input.requestsPerUserPerPeriod,
    'requestsPerUserPerPeriod',
  );
  if (!(input.period in COST_ASSUMPTIONS.periodDays)) {
    throw new RangeError(`[cost] Unknown period "${String(input.period)}"`);
  }
  if (input.cachedShare !== undefined)
    assertShare(input.cachedShare, 'cachedShare');
  if (input.toolRounds !== undefined) {
    assertFinitePositive(input.toolRounds, 'toolRounds');
  }
}

function assumptionsFor(
  input: EstimateInput,
  profile: Required<CustomProfile>,
  toolRounds: number,
): EstimateAssumptions {
  return {
    assumptionsVersion: COST_ASSUMPTIONS_VERSION,
    pricingAsOf: PRICING_AS_OF,
    pricingAssumptionsVersion: PRICING_ASSUMPTIONS_VERSION,
    emissionsAssumptionsVersion: EMISSIONS_ASSUMPTIONS_VERSION,
    deployment: input.deployment,
    profile,
    toolRounds,
  };
}

/** Entered requests per model per user per period, by raw share. */
function enteredRequests(
  mix: NormalizedMix,
  requestsPerUserPerPeriod: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of mix.priced) {
    out.set(m.modelId, (m.share / mix.shareTotal) * requestsPerUserPerPeriod);
  }
  for (const e of mix.excluded) {
    out.set(e.modelId, (e.share / mix.shareTotal) * requestsPerUserPerPeriod);
  }
  return out;
}

/**
 * Users × requests × mix → spend per period and annualized. Unpriced shares
 * contribute $0 and set `incomplete` — the mix is NEVER renormalized, so a
 * 30% excluded share visibly understates rather than silently vanishing.
 */
export function estimateSpend(
  input: EstimateInput,
  liveModels: readonly OpenAIModel[],
): EstimateResult {
  validateEstimateInput(input);
  const base = resolveProfile(input.profile);
  const profile: Required<CustomProfile> = {
    ...base,
    cachedShare: input.cachedShare ?? base.cachedShare,
  };
  const toolRounds = input.toolRounds ?? COST_ASSUMPTIONS.defaultToolRounds;
  const mix = priceMix(input, liveModels, profile, toolRounds);
  return assemble(
    mix,
    enteredRequests(mix, input.requestsPerUserPerPeriod),
    mix.shareTotal,
    input,
    assumptionsFor(input, profile, toolRounds),
  );
}

// ---------------------------------------------------------------------------
// Cap-aware bounds
// ---------------------------------------------------------------------------

/** Cells that bound requests: numeric request or token counters. */
function isRequestCell(cell: ResolvedLimit): boolean {
  return cell.unit === 'requests';
}

function isTokenCell(cell: ResolvedLimit): boolean {
  return cell.unit === 'tokens';
}

/**
 * The per-period request bound implied by ONE principal's conjunctive cells
 * for ONE model: the MIN over numeric cells. Request cells bound directly;
 * token cells via ceil(limit / tokensPerRequest) — ceil, not floor, because
 * pre-flight blocks only at used ≥ limit, so the request that crosses the
 * cap still starts. Day windows × periodDays; calendar-month windows ÷
 * 30.4375 (flagged approximate). `false` or a 0 counter → blocked; no
 * numeric cell → unbounded (never 0).
 */
export function boundRequests(
  cells: readonly ResolvedLimit[],
  tokensPerRequest: number,
  periodDays: number,
): RequestBound {
  assertFinitePositive(periodDays, 'periodDays');
  const monthDays = COST_ASSUMPTIONS.periodDays.month;

  let best:
    | { requests: number; cell: ResolvedLimit; approximate: boolean }
    | undefined;

  for (const cell of cells) {
    if (cell.value === false) return { kind: 'blocked' };
    if (typeof cell.value !== 'number') continue; // null / true = unlimited
    if (!isRequestCell(cell) && !isTokenCell(cell)) continue;
    if (cell.window !== 'day' && cell.window !== 'month') continue;
    if (cell.value === 0) return { kind: 'blocked' };

    let perWindow: number;
    if (isTokenCell(cell)) {
      assertFinitePositive(tokensPerRequest, 'tokensPerRequest');
      perWindow = Math.ceil(cell.value / tokensPerRequest);
    } else {
      perWindow = cell.value;
    }
    const approximate = cell.window === 'month';
    const requests = approximate
      ? (perWindow * periodDays) / monthDays
      : perWindow * periodDays;
    if (!best || requests < best.requests) {
      best = { requests, cell, approximate };
    }
  }

  if (!best) return { kind: 'unbounded' };
  return {
    kind: 'bounded',
    requestsPerUserPerPeriod: best.requests,
    bindingCell: counterCellName(best.cell),
    approximateMonthConversion: best.approximate,
  };
}

function cellsFor(
  cellsByModelId: Record<string, readonly ResolvedLimit[]>,
  modelId: string,
): readonly ResolvedLimit[] {
  const exact = cellsByModelId[modelId];
  if (exact) return exact;
  const wanted = modelId.toLowerCase();
  for (const key of Object.keys(cellsByModelId)) {
    if (key.toLowerCase() === wanted) return cellsByModelId[key];
  }
  return [];
}

/**
 * Applies an envelope (a shared bound over several models' requests) to a
 * request vector by proportional scaling. Returns the binding cell when it
 * clipped anything.
 */
function applyEnvelope(
  requests: Map<string, number>,
  memberIds: readonly string[],
  bound: RequestBound,
): string | undefined {
  if (bound.kind === 'unbounded') return undefined;
  let sum = 0;
  for (const id of memberIds) sum += requests.get(id) ?? 0;
  if (bound.kind === 'blocked') {
    if (sum === 0) return undefined;
    for (const id of memberIds) requests.set(id, 0);
    return 'blocked';
  }
  if (sum <= bound.requestsPerUserPerPeriod) return undefined;
  const factor = sum > 0 ? bound.requestsPerUserPerPeriod / sum : 0;
  for (const id of memberIds)
    requests.set(id, (requests.get(id) ?? 0) * factor);
  return bound.bindingCell;
}

/**
 * Enforces the conjunctive cells over a per-model request vector, in place:
 * per-model cells first, then family envelopes (Σ members ≤ family cap), then
 * the unqualified envelopes shared by every model (chat.messagesPerDay and
 * the token caps, at the current blended tokens/request). Returns the cells
 * that clipped something.
 */
function enforceCaps(
  requests: Map<string, number>,
  mix: NormalizedMix,
  cellsByModelId: Record<string, readonly ResolvedLimit[]>,
  periodDays: number,
  /** `true` → raise each model to its own cap before applying envelopes. */
  raiseToCap: boolean,
): string[] {
  const binding = new Set<string>();
  const tokensById = new Map<string, number>();
  const families = new Map<string, { cells: ResolvedLimit[]; ids: string[] }>();
  const shared = new Map<string, ResolvedLimit>();

  // 1. Per-model cells — and collect the family / shared cells on the way.
  for (const m of mix.priced) {
    const tokens = countedTokensPerRequest(m.perRequest);
    tokensById.set(m.modelId, tokens);
    const cells = cellsFor(cellsByModelId, m.modelId);
    const own: ResolvedLimit[] = [];
    for (const cell of cells) {
      if (cell.modelId) {
        own.push(cell);
      } else if (cell.series) {
        const key = cell.series.toLowerCase();
        const fam = families.get(key) ?? { cells: [], ids: [] };
        if (!fam.ids.includes(m.modelId)) fam.ids.push(m.modelId);
        if (
          !fam.cells.some((c) => counterCellName(c) === counterCellName(cell))
        ) {
          fam.cells.push(cell);
        }
        families.set(key, fam);
      } else {
        shared.set(counterCellName(cell), cell);
      }
    }
    // The model's OWN ceiling is the min over everything that applies to it
    // (own + family + shared); envelopes below only handle the joint sums.
    const all = boundRequests(cells, tokens, periodDays);
    const current = requests.get(m.modelId) ?? 0;
    if (all.kind === 'blocked') {
      if (current > 0 || raiseToCap)
        binding.add(bindingCellOf(own, cells, tokens, periodDays));
      requests.set(m.modelId, 0);
    } else if (all.kind === 'bounded') {
      if (raiseToCap) {
        requests.set(m.modelId, all.requestsPerUserPerPeriod);
        binding.add(all.bindingCell);
      } else if (current > all.requestsPerUserPerPeriod) {
        requests.set(m.modelId, all.requestsPerUserPerPeriod);
        binding.add(all.bindingCell);
      }
    }
  }

  // 2. Family envelopes: Σ members ≤ family cap.
  for (const fam of families.values()) {
    const tokens = blendedTokens(requests, tokensById, fam.ids);
    const clipped = applyEnvelope(
      requests,
      fam.ids,
      boundRequests(fam.cells, tokens, periodDays),
    );
    if (clipped) binding.add(clipped);
  }

  // 3. Shared envelopes over every priced model.
  const ids = mix.priced.map((m) => m.modelId);
  const tokens = blendedTokens(requests, tokensById, ids);
  const clipped = applyEnvelope(
    requests,
    ids,
    boundRequests([...shared.values()], tokens, periodDays),
  );
  if (clipped) binding.add(clipped);

  binding.delete('blocked');
  return [...binding];
}

/** Which cell blocks a model — the first `false`/0 cell, most specific first. */
function bindingCellOf(
  own: readonly ResolvedLimit[],
  all: readonly ResolvedLimit[],
  tokens: number,
  periodDays: number,
): string {
  const ordered = [...own, ...all.filter((c) => !own.includes(c))];
  for (const cell of ordered) {
    const bound = boundRequests([cell], tokens, periodDays);
    if (bound.kind === 'blocked') return counterCellName(cell);
  }
  return 'blocked';
}

/** Request-weighted tokens per request over a set of models (0 when idle). */
function blendedTokens(
  requests: Map<string, number>,
  tokensById: Map<string, number>,
  ids: readonly string[],
): number {
  let weighted = 0;
  let sum = 0;
  for (const id of ids) {
    const r = requests.get(id) ?? 0;
    weighted += r * (tokensById.get(id) ?? 0);
    sum += r;
  }
  if (sum > 0) return weighted / sum;
  // Idle: fall back to the plain mean so a token cap can still be evaluated.
  let mean = 0;
  for (const id of ids) mean += tokensById.get(id) ?? 0;
  return ids.length > 0 ? mean / ids.length : 0;
}

/**
 * The estimate cross-checked against ONE principal's resolved cells
 * (`cellsByModelId[modelId]` = the conjunctive cells a request on that model
 * must satisfy: model.allowed + model.requests model/family cells, plus the
 * unqualified chat.messagesPerDay / tokens cells).
 *
 * `entered` is the plain estimate. `ceiling` is the spend if every user
 * reached every cap that applies (unbounded models keep the entered requests;
 * blocked ones drop to 0; family and shared caps are envelopes, scaled
 * proportionally, never summed). `capBinding` says the entered requests
 * exceed what the caps allow; `bindingCells` name the cells that shape the
 * ceiling. Excluded (unpriced) models take no part in the cap arithmetic —
 * counting them would only lower the bound.
 */
export function estimateSpendWithCaps(
  input: EstimateInput,
  liveModels: readonly OpenAIModel[],
  cellsByModelId: Record<string, readonly ResolvedLimit[]>,
): EstimateWithCaps {
  validateEstimateInput(input);
  const base = resolveProfile(input.profile);
  const profile: Required<CustomProfile> = {
    ...base,
    cachedShare: input.cachedShare ?? base.cachedShare,
  };
  const toolRounds = input.toolRounds ?? COST_ASSUMPTIONS.defaultToolRounds;
  const mix = priceMix(input, liveModels, profile, toolRounds);
  const assumptions = assumptionsFor(input, profile, toolRounds);
  const periodDays = COST_ASSUMPTIONS.periodDays[input.period];

  const enteredRequestsByModel = enteredRequests(
    mix,
    input.requestsPerUserPerPeriod,
  );
  const entered = assemble(
    mix,
    enteredRequestsByModel,
    mix.shareTotal,
    input,
    assumptions,
  );

  // Does the entered load fit under the caps?
  const effective = new Map(enteredRequestsByModel);
  enforceCaps(effective, mix, cellsByModelId, periodDays, false);
  let capBinding = false;
  for (const m of mix.priced) {
    const before = enteredRequestsByModel.get(m.modelId) ?? 0;
    const after = effective.get(m.modelId) ?? 0;
    if (after < before - before * 1e-12) capBinding = true;
  }

  // Spend at the cap.
  const atCap = new Map(enteredRequestsByModel);
  const bindingCells = enforceCaps(
    atCap,
    mix,
    cellsByModelId,
    periodDays,
    true,
  );
  const ceiling =
    bindingCells.length === 0
      ? entered
      : assemble(mix, atCap, mix.shareTotal, input, assumptions);

  return { entered, ceiling, capBinding, bindingCells };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export type UsdParts =
  | { kind: 'zero' }
  | { kind: 'lessThan'; text: string }
  | { kind: 'amount'; text: string };

function usdFormatter(locale: string): Intl.NumberFormat {
  const options: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    roundingMode: 'halfExpand',
  };
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat('en-US', options);
  }
}

/**
 * Money for display — the ONLY place a figure is rounded. `zero` for exactly
 * 0 (the caller decides whether "$0.00" is honest — never for an unpriced
 * model), `lessThan` with the formatted one-cent floor below $0.005, else
 * the Intl currency string (grouping, two decimals, round-half-away-from-zero
 * so 7.305 → $7.31). Throws RangeError on non-finite or negative input.
 */
export function formatUsdParts(value: number, locale: string): UsdParts {
  assertFiniteNonNegative(value, 'value');
  if (value === 0) return { kind: 'zero' };
  const formatter = usdFormatter(locale);
  if (value < 0.005) return { kind: 'lessThan', text: formatter.format(0.01) };
  return { kind: 'amount', text: formatter.format(value) };
}

/** Per-1,000-requests figure for models whose per-request cost rounds to nothing. */
export function perThousandRequestsUsd(perRequest: number): number {
  assertFiniteNonNegative(perRequest, 'perRequest');
  return perRequest * 1000;
}
