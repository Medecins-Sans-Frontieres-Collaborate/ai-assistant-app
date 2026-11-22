/**
 * The facts the limits admin's Models page shows beside each model's access
 * rules: what a request costs, what a cap can cost, the footprint, when the
 * model retires, and how it is actually used.
 *
 * Pure and dependency-light (no React, no feature flags) so every figure can
 * be unit-tested. See docs/MODELS_PAGE_ANALYTICS_DATA.md.
 *
 * ESTIMATES, and labelled as such wherever they are shown: cost and footprint
 * are counted requests multiplied by an ASSUMED request (the typical request
 * of config/emissions.json, priced at list price), never measured spend.
 * A figure that cannot be estimated is `null`, never 0.
 */
import type { LimitEntry, ModelAccessRule } from '@/lib/services/limits/types';
import type { CellInsight, UsageInsights } from '@/lib/services/limits/wire';

import {
  PricingIndex,
  lookupPricing,
  modelRequestCost,
} from '@/lib/utils/app/limitsPricing';
import { ruleDifferences } from '@/lib/utils/app/modelAccessGrid';
import {
  AccessState,
  ModelAccessDimension,
  effectiveAccessFor,
  emptyRule,
  ruleFor,
  upsertRule,
} from '@/lib/utils/app/modelAccessTree';
import { COST_ASSUMPTIONS } from '@/lib/utils/shared/costEstimator';
import {
  ModelSizeClass,
  estimateTypicalRequestCO2,
} from '@/lib/utils/shared/emissions';
import {
  FORCED_MODEL_RETIREMENTS,
  RETIREMENT_MOVE_DAYS,
  RETIREMENT_NOTICE_DAYS,
} from '@/lib/utils/shared/modelRetirement';
import {
  REQUEST_BUCKET_EDGES,
  countAtOrAbove,
  histogramOf,
  quantilesOf,
} from '@/lib/utils/shared/usageDistribution';

import type { OpenAIModel } from '@/types/openai';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface ModelCostFacts {
  inputPer1M: number;
  outputPer1M: number;
  /** USD for one typical request at list price. */
  typical: number;
  /** USD for one long request (the `heavy` profile): the upper range. */
  heavy: number;
}

/**
 * What one request on a model costs, or `null` when the model has no usable
 * list price (agents, the user's own models, catalog entries without one).
 */
export function modelCostFacts(
  index: PricingIndex | null,
  modelId: string,
): ModelCostFacts | null {
  if (!index) return null;
  const entry = lookupPricing(index, modelId);
  if (!entry) return null;
  try {
    return {
      inputPer1M: entry.pricing.inputPer1M,
      outputPer1M: entry.pricing.outputPer1M,
      typical: modelRequestCost(entry, 'typical').total,
      heavy: modelRequestCost(entry, 'heavy').total,
    };
  } catch {
    return null;
  }
}

/** Days in the month every monthly estimate uses (config/cost.json). */
export const DAYS_PER_MONTH = COST_ASSUMPTIONS.periodDays.month;

/**
 * The most one person can cost in a month under a daily request cap:
 * every day at the cap, every request at `perRequestUsd`.
 */
export function monthlyCeilingUsd(
  requestsPerDay: number,
  perRequestUsd: number,
): number {
  return requestsPerDay * perRequestUsd * DAYS_PER_MONTH;
}

/** What a cap on one model can cost one person. */
export type CapCeiling =
  | { kind: 'capped'; typical: number; heavy: number }
  /** No cap: there is no most. */
  | { kind: 'unbounded' }
  /** Switched off: nothing can be spent. */
  | { kind: 'off' };

/**
 * The monthly ceiling for terms on a model.
 *
 * @param terms - A daily request cap, `null` for unlimited, `false` for off.
 * @param cost - The model's request costs; `null` gives `null` (unpriced).
 */
export function capCeiling(
  terms: number | null | false,
  cost: ModelCostFacts | null,
): CapCeiling | null {
  if (terms === false || terms === 0) return { kind: 'off' };
  if (!cost) return null;
  if (terms === null) return { kind: 'unbounded' };
  return {
    kind: 'capped',
    typical: monthlyCeilingUsd(terms, cost.typical),
    heavy: monthlyCeilingUsd(terms, cost.heavy),
  };
}

// ---------------------------------------------------------------------------
// Footprint
// ---------------------------------------------------------------------------

export interface ModelFootprintFacts {
  sizeClass: ModelSizeClass;
  /** gCO2e for one typical request. */
  gramsPerRequest: number;
}

/**
 * The footprint of one typical request, or `null` when the model has no size
 * class of its own. The default size class is deliberately NOT applied here:
 * an admin comparing models must be able to tell "standard" from "nobody
 * has said".
 */
export function modelFootprintFacts(
  model: Pick<OpenAIModel, 'sizeClass' | 'modelType'> | undefined,
): ModelFootprintFacts | null {
  if (!model?.sizeClass) return null;
  return {
    sizeClass: model.sizeClass,
    gramsPerRequest: estimateTypicalRequestCO2(
      model.sizeClass,
      model.modelType === 'reasoning',
    ).gCO2e,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Where a model is on its way out:
 *  - `past`   its date has passed (and it is still listed);
 *  - `move`   inside the last RETIREMENT_MOVE_DAYS, when people are moved off;
 *  - `notice` inside RETIREMENT_NOTICE_DAYS, when users see a notice;
 *  - `later`  it has a date further out;
 *  - `forced` it is being moved off now whatever its date says;
 *  - `none`   nothing says it is leaving.
 */
export type RetirementPhase =
  | 'past'
  | 'move'
  | 'notice'
  | 'later'
  | 'forced'
  | 'none';

export interface ModelLifecycleFacts {
  lifecycle?: OpenAIModel['lifecycle'];
  /** ISO date (YYYY-MM-DD) the model stops being served, when known. */
  retiresOn?: string;
  /** Whole days from `now` to `retiresOn`; negative once past. */
  daysLeft?: number;
  phase: RetirementPhase;
  /** The model people land on, when one is named. */
  replacementId?: string;
}

type LifecycleModel = Pick<
  OpenAIModel,
  | 'id'
  | 'lifecycle'
  | 'retiresAt'
  | 'retirementDate'
  | 'retirementReplacement'
  | 'successorId'
>;

/**
 * A model's retirement facts as of `now` (epoch ms).
 *
 * The date discovery read from the account (`retiresAt`) wins over the static
 * catalog value (`retirementDate`): the static one is a hand-maintained
 * mirror and goes stale. A forced retirement (modelRetirement.ts) outranks
 * both, because the app is already moving people off.
 */
export function modelLifecycleFacts(
  model: LifecycleModel | undefined,
  now: number,
): ModelLifecycleFacts {
  if (!model) return { phase: 'none' };
  const forcedTo = FORCED_MODEL_RETIREMENTS[model.id];
  const replacementId =
    forcedTo ?? model.successorId ?? model.retirementReplacement ?? undefined;
  const raw = model.retiresAt ?? model.retirementDate;
  const at = raw ? Date.parse(raw) : Number.NaN;
  const base = {
    ...(model.lifecycle ? { lifecycle: model.lifecycle } : {}),
    ...(replacementId ? { replacementId } : {}),
  };
  if (Number.isNaN(at)) {
    return { ...base, phase: forcedTo ? 'forced' : 'none' };
  }
  const daysLeft = Math.ceil((at - now) / DAY_MS);
  const phase: RetirementPhase = forcedTo
    ? 'forced'
    : daysLeft <= 0
      ? 'past'
      : daysLeft <= RETIREMENT_MOVE_DAYS
        ? 'move'
        : daysLeft <= RETIREMENT_NOTICE_DAYS
          ? 'notice'
          : 'later';
  return {
    ...base,
    retiresOn: new Date(at).toISOString().slice(0, 10),
    daysLeft,
    phase,
  };
}

/**
 * True once a model's retirement date has passed (today counts), whatever
 * else is said about it. A model with no date is never retired by this test.
 */
export function isRetired(lifecycle: ModelLifecycleFacts): boolean {
  return lifecycle.daysLeft !== undefined && lifecycle.daysLeft <= 0;
}

/** True when the phase needs an admin's attention now. */
export function isRetiringSoon(phase: RetirementPhase): boolean {
  return phase === 'forced' || phase === 'move' || phase === 'notice';
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Where a model's usage figures come from:
 *  - `captured` the per-model tally, which counts everyone;
 *  - `capped`   only the usage counters, which exist for people under a cap:
 *               people with no cap are missing, and totals are not known;
 *  - `none`     nothing recorded in the window.
 */
export type UsageSource = 'captured' | 'capped' | 'none';

export interface ModelUsageFacts {
  source: UsageSource;
  /** Distinct people in the window. */
  people: number;
  /** Requests in the window; `null` when only capped people are known. */
  requests: number | null;
  /** Mean requests per person on a day they used it; `null` when unknown. */
  average: number | null;
  /** Each person's busiest day, ascending. */
  peaks: number[];
  /** `peaks` holds only the largest values; low quantiles are then too high. */
  peaksTruncated: boolean;
  /** People who hit a cap, how often, and how many requests were refused. */
  capPeople: number;
  capEvents: number;
  blocked: number;
}

const NO_USAGE: ModelUsageFacts = {
  source: 'none',
  people: 0,
  requests: null,
  average: null,
  peaks: [],
  peaksTruncated: false,
  capPeople: 0,
  capEvents: 0,
  blocked: 0,
};

/** The cap evidence for a model's own `model.requests` cell, if any. */
function modelCell(
  insights: UsageInsights,
  modelId: string,
): CellInsight | undefined {
  return insights.cells[`model.requests|model:${modelId.toLowerCase()}`];
}

/**
 * One model's usage over the insights window. Prefers the per-model tally;
 * falls back to the cap counters for a model the tally has not seen yet
 * (the capture is newer than the counters).
 */
export function modelUsageFacts(
  insights: UsageInsights | undefined,
  modelId: string,
): ModelUsageFacts {
  if (!insights) return NO_USAGE;
  const cell = modelCell(insights, modelId);
  const caps = {
    capPeople: cell?.eventPeople ?? 0,
    capEvents: cell?.events ?? 0,
    blocked: cell?.blocked ?? 0,
  };
  const captured = insights.models?.[modelId.toLowerCase()];
  if (captured && captured.people > 0) {
    return {
      source: 'captured',
      people: captured.people,
      requests: captured.requests,
      average:
        captured.activePersonDays > 0
          ? captured.requests / captured.activePersonDays
          : null,
      peaks: captured.peaks,
      peaksTruncated: captured.peaksTruncated,
      ...caps,
    };
  }
  if (cell && cell.peaks.length > 0) {
    return {
      source: 'capped',
      people: cell.peaks.length,
      requests: null,
      average: null,
      peaks: cell.peaks,
      peaksTruncated: cell.peaksTruncated,
      ...caps,
    };
  }
  return { ...NO_USAGE, ...caps };
}

export interface UsageSpread {
  median: number;
  p75: number;
  p95: number;
  max: number;
}

/** The spread of people's busiest days, or `null` with nobody to describe. */
export function usageSpread(peaks: readonly number[]): UsageSpread | null {
  if (peaks.length === 0) return null;
  const quantiles = quantilesOf(peaks);
  return {
    median: quantiles.p50,
    p75: quantiles.p75,
    p95: quantiles.p95,
    max: peaks[peaks.length - 1],
  };
}

export interface HistogramBar {
  /** Inclusive range of requests in a day this bar covers. */
  from: number;
  /** `null` for the open-ended last bucket. */
  to: number | null;
  people: number;
}

/**
 * People per bucket of busiest-day requests, trimmed after the last bucket
 * anyone is in so a quiet model does not draw a row of empty bars.
 */
export function usageHistogram(peaks: readonly number[]): HistogramBar[] {
  const counts = histogramOf(peaks);
  let last = counts.length - 1;
  while (last > 0 && counts[last] === 0) last -= 1;
  return counts.slice(0, last + 1).map((people, index) => ({
    from: index === 0 ? 1 : REQUEST_BUCKET_EDGES[index - 1] + 1,
    to:
      index < REQUEST_BUCKET_EDGES.length ? REQUEST_BUCKET_EDGES[index] : null,
    people,
  }));
}

/** Round caps an admin would plausibly try. */
const CAP_LADDER: readonly number[] = [
  5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000,
];
/** Alternatives offered beside the current cap, at most. */
const MAX_CAP_ALTERNATIVES = 3;

/**
 * Caps worth replaying against the window: the current one, plus round
 * values spread between the median person and the heaviest. Ascending.
 *
 * @param current - The cap in force, or `null` for none.
 * @param peaks - Each person's busiest day, ascending.
 */
export function capCandidates(
  current: number | null,
  peaks: readonly number[],
): number[] {
  const spread = usageSpread(peaks);
  const inRange = spread
    ? CAP_LADDER.filter(
        (value) => value >= spread.median && value <= spread.max,
      )
    : [];
  const pool = inRange.filter((value) => value !== current);
  const picked: number[] = [];
  // Evenly spread through the range rather than the first few rungs.
  for (let i = 0; i < Math.min(MAX_CAP_ALTERNATIVES, pool.length); i++) {
    const position =
      pool.length <= MAX_CAP_ALTERNATIVES
        ? i
        : Math.round((i * (pool.length - 1)) / (MAX_CAP_ALTERNATIVES - 1));
    picked.push(pool[position]);
  }
  const all = current !== null ? [...picked, current] : picked;
  return [...new Set(all)].sort((a, b) => a - b);
}

export interface CapReplayRow {
  cap: number;
  /** People whose busiest day reached this cap. */
  stopped: number;
  /** `stopped` as a share of the people who used the model (0..1). */
  share: number;
}

/** What each candidate cap would have done over the window. */
export function replayCaps(
  caps: readonly number[],
  peaks: readonly number[],
): CapReplayRow[] {
  return caps.map((cap) => {
    const stopped = countAtOrAbove(peaks, cap);
    return {
      cap,
      stopped,
      share: peaks.length > 0 ? stopped / peaks.length : 0,
    };
  });
}

/** Estimated spend for counted requests, or `null` when either is unknown. */
export function estimatedSpendUsd(
  requests: number | null,
  cost: ModelCostFacts | null,
): number | null {
  return requests === null || !cost ? null : requests * cost.typical;
}

/** Estimated grams of CO2e for counted requests, or `null` when unknown. */
export function estimatedFootprintGrams(
  requests: number | null,
  footprint: ModelFootprintFacts | null,
): number | null {
  return requests === null || !footprint
    ? null
    : requests * footprint.gramsPerRequest;
}

// ---------------------------------------------------------------------------
// Everything about one model
// ---------------------------------------------------------------------------

/** Everything the Models page says about one model besides its access rules. */
export interface ModelFacts {
  modelId: string;
  /** The catalog object, when the model is known in this ring. */
  model: OpenAIModel | undefined;
  /** `null`: unpriced, or cost insights are switched off. */
  cost: ModelCostFacts | null;
  /** `null`: the model has no size class. */
  footprint: ModelFootprintFacts | null;
  lifecycle: ModelLifecycleFacts;
  usage: ModelUsageFacts;
  /** Estimated spend over the window; `null` when it cannot be estimated. */
  spendUsd: number | null;
  /** Estimated gCO2e over the window; `null` when it cannot be estimated. */
  footprintGrams: number | null;
}

export interface ModelFactsContext {
  insights: UsageInsights | undefined;
  /** `null` while cost insights are off: every cost figure is then `null`. */
  pricing: PricingIndex | null;
  /** Epoch ms the lifecycle is judged at. */
  now: number;
}

/** Gathers one model's facts. Pure. */
export function modelFacts(
  modelId: string,
  model: OpenAIModel | undefined,
  context: ModelFactsContext,
): ModelFacts {
  const cost = modelCostFacts(context.pricing, modelId);
  const footprint = modelFootprintFacts(model);
  const usage = modelUsageFacts(context.insights, modelId);
  return {
    modelId,
    model,
    cost,
    footprint,
    lifecycle: modelLifecycleFacts(model, context.now),
    usage,
    spendUsd: estimatedSpendUsd(usage.requests, cost),
    footprintGrams: estimatedFootprintGrams(usage.requests, footprint),
  };
}

// ---------------------------------------------------------------------------
// Access terms as facts
// ---------------------------------------------------------------------------

/** The `AudienceTerms` form of an access state: cap, `null`, or `false`. */
export function termsOfState(state: AccessState): number | null | false {
  if (state.kind === 'unavailable') return false;
  return state.kind === 'unlimited' ? null : state.requests;
}

// ---------------------------------------------------------------------------
// Retirement: do the rules follow people to the replacement?
// ---------------------------------------------------------------------------

/** One model as the access rules address it. */
export interface RuleSubject {
  modelId: string;
  series: string | undefined;
}

/**
 * How a retiring model's access compares with its replacement's, judged from
 * the RULES. It cannot say how many people are affected: usage is stored
 * against hashed ids, which cannot be matched to the groups, domains and
 * mails that rules name.
 */
export type ReplacementAccess =
  | { kind: 'same' }
  | {
      kind: 'differs';
      /** "Everyone else" resolves differently on the two models. */
      everyone: boolean;
      /** Groups, domains and people whose own terms differ. */
      audiences: number;
    };

function sameState(a: AccessState, b: AccessState): boolean {
  return termsOfState(a) === termsOfState(b);
}

/**
 * Compares who can use `from` with who can use `to`.
 *
 * "Everyone else" is compared as it RESOLVES (through the family and the
 * defaults), because that is what people get. Named audiences are compared
 * on the two models' own rules.
 */
export function compareReplacementAccess(
  rules: readonly ModelAccessRule[],
  defaults: readonly LimitEntry[],
  from: RuleSubject,
  to: RuleSubject,
): ReplacementAccess {
  const everyone = !sameState(
    effectiveAccessFor({ modelId: from.modelId }, from.series, defaults, rules)
      .state,
    effectiveAccessFor({ modelId: to.modelId }, to.series, defaults, rules)
      .state,
  );
  const audiences = ruleDifferences(
    ruleFor(rules, { modelId: from.modelId }),
    ruleFor(rules, { modelId: to.modelId }),
  ).filter((difference) => difference.audience !== 'everyone').length;
  return everyone || audiences > 0
    ? { kind: 'differs', everyone, audiences }
    : { kind: 'same' };
}

/**
 * The rules with `from`'s own rule copied onto `to`, replacing whatever `to`
 * had. The "everyone else" answer is written out as it resolves today, so
 * the copy means the same on a replacement in another family. Pure: the
 * result is a draft for the admin to review.
 */
export function withRuleCarriedOver(
  rules: readonly ModelAccessRule[],
  defaults: readonly LimitEntry[],
  from: RuleSubject,
  to: RuleSubject,
): ModelAccessRule[] {
  const target: ModelAccessDimension = { modelId: to.modelId };
  const source = ruleFor(rules, { modelId: from.modelId });
  const resolved = effectiveAccessFor(
    { modelId: from.modelId },
    from.series,
    defaults,
    rules,
  ).state;
  const { series: _series, ...own } = source ?? emptyRule(target);
  void _series;
  return upsertRule(rules, target, {
    ...own,
    modelId: to.modelId,
    defaultAccess: termsOfState(resolved),
  });
}

// ---------------------------------------------------------------------------
// What the spend map points out
// ---------------------------------------------------------------------------

/** A model on the map: its facts and the "everyone else" terms on it. */
export interface MappedModel {
  facts: ModelFacts;
  label: string;
  terms: number | null | false;
}

export type MapFinding =
  /** One model carries most of the estimated spend. */
  | { kind: 'concentrated'; label: string; share: number }
  /** A cap well above anything anyone did. */
  | { kind: 'unreached'; label: string; cap: number; max: number }
  /** People reached the cap. */
  | { kind: 'reached'; label: string; cap: number; people: number; of: number }
  /** Used, and nothing bounds what one person can spend. */
  | { kind: 'noCeiling'; labels: string[]; max: number };

/** Share of estimated spend from which one model is called "concentrated". */
export const CONCENTRATED_SPEND_SHARE = 0.4;
/** A cap is "never reached" when the heaviest person stayed under this share of it. */
export const UNREACHED_CAP_SHARE = 0.5;
/** Findings of one kind listed at most. */
const MAX_FINDINGS_PER_KIND = 3;

/**
 * What stands out across the models, strongest first within each kind. Every
 * finding is a statement about counted usage or estimated spend; none is
 * advice the data cannot support.
 */
export function mapFindings(models: readonly MappedModel[]): MapFinding[] {
  const findings: MapFinding[] = [];
  const used = models.filter((model) => model.facts.usage.people > 0);

  const totalSpend = used.reduce(
    (sum, model) => sum + (model.facts.spendUsd ?? 0),
    0,
  );
  if (totalSpend > 0) {
    const top = [...used].sort(
      (a, b) => (b.facts.spendUsd ?? 0) - (a.facts.spendUsd ?? 0),
    )[0];
    const share = (top.facts.spendUsd ?? 0) / totalSpend;
    if (used.length > 1 && share >= CONCENTRATED_SPEND_SHARE) {
      findings.push({ kind: 'concentrated', label: top.label, share });
    }
  }

  const reached = used
    .filter(
      (model) =>
        typeof model.terms === 'number' && model.facts.usage.capPeople > 0,
    )
    .sort((a, b) => b.facts.usage.capPeople - a.facts.usage.capPeople)
    .slice(0, MAX_FINDINGS_PER_KIND);
  for (const model of reached) {
    findings.push({
      kind: 'reached',
      label: model.label,
      cap: model.terms as number,
      people: model.facts.usage.capPeople,
      of: model.facts.usage.people,
    });
  }

  const unreached = used
    .flatMap((model) => {
      const max = model.facts.usage.peaks.at(-1);
      return typeof model.terms === 'number' &&
        max !== undefined &&
        // A truncated list still ends at the true maximum (largest are kept).
        max < model.terms * UNREACHED_CAP_SHARE
        ? [{ label: model.label, cap: model.terms, max }]
        : [];
    })
    .sort((a, b) => a.max / a.cap - b.max / b.cap)
    .slice(0, MAX_FINDINGS_PER_KIND);
  for (const model of unreached) {
    findings.push({ kind: 'unreached', ...model });
  }

  const open = used.filter((model) => model.terms === null);
  if (open.length > 0) {
    findings.push({
      kind: 'noCeiling',
      labels: open
        .sort((a, b) => b.facts.usage.people - a.facts.usage.people)
        .slice(0, MAX_FINDINGS_PER_KIND)
        .map((model) => model.label),
      max: Math.max(
        ...open.map((model) => model.facts.usage.peaks.at(-1) ?? 0),
      ),
    });
  }
  return findings;
}
