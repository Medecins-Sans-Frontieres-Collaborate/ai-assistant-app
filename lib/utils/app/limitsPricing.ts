/**
 * Limits-admin adapter over the pure cost estimator: the draft-aware
 * derivations the editors and the effective-limits preview need
 * (docs/LIMITS_COST_INSIGHTS_DESIGN.md §3a).
 *
 * Pure and dependency-light (no React, Node, or feature-flag imports) so it
 * can be unit-tested under the node config, like limitsModelCatalog.ts.
 * Everything here is an upper-bound estimate at list price for a "typical"
 * request unless a profile says otherwise; see costEstimator.ts for what
 * the numbers are and are not.
 *
 * Conventions shared with the resolver (lib/services/limits/resolver.ts
 * resolveModelCells / pickGlobalEntry / entryAppliesTo), which this adapter
 * MUST mirror or the spend ceiling stops being an upper bound:
 *  - model ids and series compare case-insensitively (stored qualifiers are
 *    lowercased); a `null` cap is UNBOUNDED (never $0);
 *  - a per-model key has TWO conjunctive cells — the MODEL cell and (only
 *    when the model declares a `series`) the FAMILY cell. An unqualified
 *    entry is never a third cell: it is merely the lowest-specificity
 *    candidate INSIDE each of those two, shadowed by a qualified entry in the
 *    same layer. A series entry never competes in the model cell, a model
 *    entry never in the family cell;
 *  - layers stack draft-before-defaults: a layer that speaks to a cell (at
 *    any specificity) wins over the layer below;
 *  - a family cap is ONE shared counter (`family:<series>.requests`), an
 *    envelope over its members — never a per-member allowance;
 *  - an upper bound takes the MIN over axes and never sums them.
 */
import type { LimitValue } from '@/lib/services/limits/types';

import {
  COST_ASSUMPTIONS,
  CustomProfile,
  Deployment,
  ModelPricing,
  PerRequestCost,
  RequestProfile,
  blendedPerTokenUsd,
  countedTokensPerRequest,
  deploymentMultiplierFor,
  estimateRequestCost,
  exclusionForModel,
  outputMultiplierFor,
  resolveProfile,
} from '@/lib/utils/shared/costEstimator';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

// ---------------------------------------------------------------------------
// Pricing index
// ---------------------------------------------------------------------------

export interface PricingIndexEntry {
  /** The catalog id as spelled by the model object. */
  id: string;
  model: OpenAIModel;
  pricing: ModelPricing;
  /** Present in the list the admin is looking at (vs. the static fallback). */
  servedInRing: boolean;
}

/** Keyed by LOWERCASED model id. */
export type PricingIndex = ReadonlyMap<string, PricingIndexEntry>;

/**
 * Case-insensitive id → pricing over the served list, falling back to the
 * static OpenAIModels registry for ids this ring does not serve (a stored
 * limit can still name them — label those "not served in this ring", the
 * same way isUnknownQualifier annotates the qualifier). Unpriceable models
 * (agents, byom, local, no `pricing`) are left out. Only ring-served entries
 * take part in allowed sets and ranges (see servedModels).
 */
export function buildPricingIndex(
  models: readonly OpenAIModel[],
): PricingIndex {
  const index = new Map<string, PricingIndexEntry>();
  const add = (model: OpenAIModel, servedInRing: boolean) => {
    if (!model.id) return;
    const key = model.id.toLowerCase();
    if (index.has(key)) return;
    if (exclusionForModel(model)) return;
    index.set(key, {
      id: model.id,
      model,
      pricing: model.pricing as ModelPricing,
      servedInRing,
    });
  };
  for (const model of models) add(model, true);
  for (const model of Object.values(OpenAIModels)) add(model, false);
  return index;
}

export function lookupPricing(
  index: PricingIndex,
  modelId: string,
): PricingIndexEntry | undefined {
  return index.get(modelId.toLowerCase());
}

// ---------------------------------------------------------------------------
// Per-request cost for an indexed model
// ---------------------------------------------------------------------------

export interface ModelRequestCostOptions {
  /** Default 'global' (×1). */
  deployment?: Deployment;
  reasoningEffort?: string;
  toolRounds?: number;
  /** Overrides the profile's cached share. */
  cachedShare?: number;
}

/** The cost of one request on an indexed model at a profile. */
export function modelRequestCost(
  entry: Pick<PricingIndexEntry, 'model' | 'pricing'>,
  profile: RequestProfile,
  opts: ModelRequestCostOptions = {},
): PerRequestCost {
  const resolved: Required<CustomProfile> = resolveProfile(profile);
  const { multiplier } = deploymentMultiplierFor(
    entry.pricing,
    opts.deployment ?? 'global',
  );
  return estimateRequestCost(entry.pricing, {
    promptTokens: resolved.promptTokens,
    completionTokens: resolved.completionTokens,
    cachedShare: opts.cachedShare ?? resolved.cachedShare,
    deploymentMultiplier: multiplier,
    outputMultiplier: outputMultiplierFor(entry.model, opts.reasoningEffort),
    toolRounds: opts.toolRounds,
  });
}

// ---------------------------------------------------------------------------
// Allowed set
// ---------------------------------------------------------------------------

/**
 * A limit cell as the editors and the preview hold it: a stored entry, a
 * resolved cell, or a `MyLimit` row all satisfy this.
 */
export interface CostCell {
  limitKey: string;
  modelId?: string;
  series?: string;
  value: LimitValue;
}

/**
 * The editors hold drafts keyed `<limitKey>`, `<limitKey>@model:<id>` or
 * `<limitKey>@family:<series>` (components/Limits/types.ts draftKey); an
 * `undefined` value means inherit. Accepted here so a row can pass its draft
 * straight through.
 */
export type CostDraft = Readonly<Record<string, LimitValue | undefined>>;

export type CostRules = readonly CostCell[] | CostDraft;

function toCells(rules: CostRules): CostCell[] {
  if (Array.isArray(rules)) return rules as CostCell[];
  const cells: CostCell[] = [];
  for (const [key, value] of Object.entries(rules as CostDraft)) {
    if (value === undefined) continue;
    const [limitKey, qualifier] = key.split('@');
    if (!qualifier) {
      cells.push({ limitKey, value });
    } else if (qualifier.startsWith('model:')) {
      cells.push({
        limitKey,
        modelId: qualifier.slice('model:'.length),
        value,
      });
    } else if (qualifier.startsWith('family:')) {
      cells.push({
        limitKey,
        series: qualifier.slice('family:'.length),
        value,
      });
    }
  }
  return cells;
}

function sameId(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Restrictiveness ordering, the resolver's same-specificity tie-break
 * (resolver.ts restrictiveness): false < 0 < 1 < … < null < true.
 */
function restrictiveness(value: LimitValue): number {
  if (value === false) return -1;
  if (value === true) return Number.POSITIVE_INFINITY;
  if (value === null) return Number.MAX_SAFE_INTEGER;
  return value;
}

/** Which of a per-model key's two conjunctive cells is being resolved. */
type CellKind = 'model' | 'family';

/**
 * The value ONE cell (the model cell or the family cell) takes from ONE
 * layer: the cell's qualified entry when the layer has one, else the layer's
 * unqualified entry, else `undefined` (the layer is silent). Mirrors
 * entryAppliesTo + qualifierSpecificity in resolver.ts — a series entry
 * never competes in the model cell and a model entry never in the family
 * cell — so an unqualified value is a shadowed FALLBACK inside each cell,
 * never a constraint of its own. The family cell of a model with no series
 * does not exist (resolveModelCells) and is `undefined` here.
 */
function layerCellValue(
  cells: readonly CostCell[],
  limitKey: string,
  model: OpenAIModel,
  kind: CellKind,
): LimitValue | undefined {
  if (kind === 'family' && !model.series) return undefined;
  let best: { specificity: number; value: LimitValue } | undefined;
  for (const cell of cells) {
    if (cell.limitKey !== limitKey) continue;
    let specificity: number;
    if (cell.modelId) {
      if (kind !== 'model' || !sameId(cell.modelId, model.id)) continue;
      specificity = 1;
    } else if (cell.series) {
      if (kind !== 'family' || !sameId(cell.series, model.series)) continue;
      specificity = 1;
    } else {
      specificity = 0;
    }
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity &&
        restrictiveness(cell.value) < restrictiveness(best.value))
    ) {
      best = { specificity, value: cell.value };
    }
  }
  return best?.value;
}

/** Draft first, then the global defaults: the first layer that speaks wins. */
type CellLayers = readonly (readonly CostCell[])[];

function cellValue(
  layers: CellLayers,
  limitKey: string,
  model: OpenAIModel,
  kind: CellKind,
): LimitValue | undefined {
  for (const layer of layers) {
    const value = layerCellValue(layer, limitKey, model, kind);
    if (value !== undefined) return value;
  }
  return undefined;
}

function toLayers(draft: CostRules, globalDefaults?: CostRules): CellLayers {
  const layers: (readonly CostCell[])[] = [toCells(draft)];
  if (globalDefaults) layers.push(toCells(globalDefaults));
  return layers;
}

/**
 * The models a principal could actually pick in this ring: served here and
 * not disabled. Static-fallback entries exist so a STORED qualifier can be
 * priced; they are never part of an allowed set.
 */
export function servedModels(index: PricingIndex): PricingIndexEntry[] {
  return [...index.values()].filter(
    (entry) => entry.servedInRing && entry.model.isDisabled !== true,
  );
}

/**
 * The served models a principal may still use. Mirrors checkGate →
 * resolveModelCells: a model is allowed only when its MODEL cell and (when it
 * has a series) its FAMILY cell are both not `false`, each cell resolved as
 * qualified-else-unqualified in the draft first, then — when supplied — in
 * the global defaults. A model-level `true` never rescues a family-level (or,
 * through the family cell, an unqualified) `false`. A scoped admin never sees
 * the defaults; pass none and say so in the UI.
 */
export function allowedModels(
  index: PricingIndex,
  draft: CostRules,
  globalDefaults?: CostRules,
): PricingIndexEntry[] {
  const layers = toLayers(draft, globalDefaults);
  const out: PricingIndexEntry[] = [];
  for (const entry of servedModels(index)) {
    if (cellValue(layers, 'model.allowed', entry.model, 'model') === false) {
      continue;
    }
    if (cellValue(layers, 'model.allowed', entry.model, 'family') === false) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Family range
// ---------------------------------------------------------------------------

export interface FamilyRange {
  /** Cheapest member's per-request total, USD. */
  min: number;
  /** Priciest member's per-request total, USD — a family cap bounds via this. */
  max: number;
  memberIds: string[];
  cheapestModelId: string;
  priciestModelId: string;
}

/**
 * Per-request range over a family's enabled members (served in this ring,
 * not `isDisabled`). `null` when the series has no such priced member —
 * never a $0 range; the UI labels it "not served in this ring".
 */
export function familyRange(
  series: string,
  index: PricingIndex,
  profile: RequestProfile,
): FamilyRange | null {
  let range: FamilyRange | null = null;
  for (const entry of servedModels(index)) {
    if (!sameId(entry.model.series, series)) continue;
    const cost = modelRequestCost(entry, profile).total;
    if (!range) {
      range = {
        min: cost,
        max: cost,
        memberIds: [entry.id],
        cheapestModelId: entry.id,
        priciestModelId: entry.id,
      };
      continue;
    }
    range.memberIds.push(entry.id);
    if (cost < range.min) {
      range.min = cost;
      range.cheapestModelId = entry.id;
    }
    if (cost > range.max) {
      range.max = cost;
      range.priciestModelId = entry.id;
    }
  }
  return range;
}

// ---------------------------------------------------------------------------
// Ceiling spend per day
// ---------------------------------------------------------------------------

export type CeilingAxis = 'messages' | 'models' | 'tokens' | 'blocked';

export type SpendCeiling =
  | {
      bounded: true;
      usdPerDay: number;
      /** The axis that produced the minimum. */
      axis: CeilingAxis;
      /** Every axis that binds, for the "why" line. */
      axes: Partial<Record<Exclude<CeilingAxis, 'blocked'>, number>>;
      /** The tokens axis came from the calendar-month cap ÷ 30.4375. */
      approximateMonthConversion: boolean;
      /** The allowed model whose request is dearest at this profile. */
      priciestModelId: string | null;
    }
  | { bounded: false };

function numericUnqualified(
  cells: readonly CostCell[],
  limitKey: string,
): number | undefined {
  for (const cell of cells) {
    if (cell.limitKey !== limitKey || cell.modelId || cell.series) continue;
    if (typeof cell.value === 'number') return cell.value;
  }
  return undefined;
}

/** A numeric cell caps; `null` / a boolean / silence leave it unbounded. */
function numericCap(value: LimitValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * The most a principal can spend per calendar day under these cells — the
 * MIN over the axes that bind (never a sum, the caps are conjunctive):
 *  - messages: `chat.messagesPerDay` × the priciest allowed request;
 *  - models:   the most the `model.requests` cells let through, priced at
 *              each model's request cost. A model is capped by its MODEL
 *              cell (model-qualified, else unqualified) and, when it has a
 *              series, by its FAMILY cell (series-qualified, else
 *              unqualified) — a family cell is ONE shared counter, so it is
 *              an envelope spent on the dearest members first, never a
 *              per-member allowance. Bounded only when EVERY allowed model
 *              is capped by at least one of its cells;
 *  - tokens:   `chat.tokensPerDay` (and the calendar-month cap ÷ 30.4375,
 *              flagged approximate) as ceil(cap / tokens per request) ×
 *              request cost, at the allowed model where that is dearest.
 * `cells` is the draft (or the preview's resolved rows); `globalDefaults`,
 * when supplied, is the layer below it, as in allowedModels.
 * `bounded: false` when no axis binds (or nothing priced is served, so no
 * bound can be stated); axis 'blocked' at $0 when every served model is
 * disallowed. Assumes the cap is reached every calendar day.
 */
export function ceilingSpendPerDay(
  cells: CostRules,
  index: PricingIndex,
  profile: RequestProfile,
  globalDefaults?: CostRules,
): SpendCeiling {
  if (servedModels(index).length === 0) return { bounded: false };
  const allowed = allowedModels(index, cells, globalDefaults);
  if (allowed.length === 0) {
    return {
      bounded: true,
      usdPerDay: 0,
      axis: 'blocked',
      axes: {},
      approximateMonthConversion: false,
      priciestModelId: null,
    };
  }
  const layers = toLayers(cells, globalDefaults);

  const costs = allowed.map((entry) => ({
    entry,
    perRequest: modelRequestCost(entry, profile),
  }));
  const priciest = costs.reduce((a, b) =>
    b.perRequest.total > a.perRequest.total ? b : a,
  );

  const axes: Partial<Record<Exclude<CeilingAxis, 'blocked'>, number>> = {};
  let monthApproximate = false;

  const unqualified = (limitKey: string): number | undefined => {
    for (const layer of layers) {
      const value = numericUnqualified(layer, limitKey);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const messagesPerDay = unqualified('chat.messagesPerDay');
  if (messagesPerDay !== undefined) {
    axes.messages = messagesPerDay * priciest.perRequest.total;
  }

  // Models axis. Own-cell caps add up (each `model:<id>.requests` is its own
  // counter); a family cap is spent greedily on its priciest members, each
  // up to its own cap — the exact maximum enforcement lets through, since
  // every model sits in at most one family.
  let modelsAxis = 0;
  let everyModelCapped = true;
  const families = new Map<
    string,
    { cap: number; members: { cost: number; ownCap: number | undefined }[] }
  >();
  for (const { entry, perRequest } of costs) {
    const ownCap = numericCap(
      cellValue(layers, 'model.requests', entry.model, 'model'),
    );
    const familyCap = numericCap(
      cellValue(layers, 'model.requests', entry.model, 'family'),
    );
    if (ownCap === undefined && familyCap === undefined) {
      everyModelCapped = false;
      break;
    }
    if (familyCap === undefined) {
      modelsAxis += (ownCap as number) * perRequest.total;
      continue;
    }
    const key = (entry.model.series as string).toLowerCase();
    const family = families.get(key) ?? { cap: familyCap, members: [] };
    family.members.push({ cost: perRequest.total, ownCap });
    families.set(key, family);
  }
  if (everyModelCapped) {
    for (const { cap, members } of families.values()) {
      let remaining = cap;
      for (const member of [...members].sort((a, b) => b.cost - a.cost)) {
        const take =
          member.ownCap === undefined
            ? remaining
            : Math.min(member.ownCap, remaining);
        modelsAxis += take * member.cost;
        remaining -= take;
        if (remaining <= 0) break;
      }
    }
    axes.models = modelsAxis;
  }

  const tokensPerDay = unqualified('chat.tokensPerDay');
  const tokensPerMonth = unqualified('chat.tokensPerMonth');
  const dearestFor = (tokenCap: number): number =>
    costs.reduce(
      (max, { perRequest }) =>
        Math.max(
          max,
          Math.ceil(tokenCap / countedTokensPerRequest(perRequest)) *
            perRequest.total,
        ),
      0,
    );
  let tokensAxis: number | undefined;
  if (tokensPerDay !== undefined) tokensAxis = dearestFor(tokensPerDay);
  if (tokensPerMonth !== undefined) {
    const perDay =
      dearestFor(tokensPerMonth) / COST_ASSUMPTIONS.periodDays.month;
    if (tokensAxis === undefined || perDay < tokensAxis) {
      tokensAxis = perDay;
      monthApproximate = true;
    }
  }
  if (tokensAxis !== undefined) axes.tokens = tokensAxis;

  let axis: Exclude<CeilingAxis, 'blocked'> | undefined;
  let usdPerDay = Number.POSITIVE_INFINITY;
  for (const key of ['messages', 'models', 'tokens'] as const) {
    const value = axes[key];
    if (value !== undefined && value < usdPerDay) {
      usdPerDay = value;
      axis = key;
    }
  }
  if (!axis) return { bounded: false };
  return {
    bounded: true,
    usdPerDay,
    axis,
    axes,
    approximateMonthConversion: axis === 'tokens' && monthApproximate,
    priciestModelId: priciest.entry.id,
  };
}

// ---------------------------------------------------------------------------
// Spent so far
// ---------------------------------------------------------------------------

export interface SpentSoFar {
  usd: number;
  /** Which counters the figure was derived from — a FLOOR, not a bill. */
  basis: 'models' | 'tokens' | 'messages';
  window: 'day' | 'month';
  /** `model:<id>.requests` counters whose model has no price (skipped). */
  unpricedCells: string[];
}

const MODEL_REQUESTS_CELL = /^model:(.+)\.requests$/;

/**
 * Spend implied by the counters the preview fetched (keyed by
 * counterCellName): Σ `model:<id>.requests` × that model's request cost when
 * any are present; else `chat.tokensPerDay` (then `chat.tokensPerMonth`)
 * × the HIGHEST blended $/token among the allowed models — the same rule the
 * token-cap hint uses (CostHint), so the two surfaces price one counter at
 * one rate; else `chat.messagesPerDay` × the priciest allowed request.
 * `null` when nothing usable was metered. Counted requests × a typical
 * profile is a floor. `globalDefaults` layers below `cells` as in
 * allowedModels.
 */
export function spentSoFarUsd(
  usage: Readonly<Record<string, { used: number }>>,
  cells: CostRules,
  index: PricingIndex,
  profile: RequestProfile,
  globalDefaults?: CostRules,
): SpentSoFar | null {
  let modelUsd = 0;
  let sawModelCell = false;
  const unpricedCells: string[] = [];
  for (const [cell, { used }] of Object.entries(usage)) {
    const match = MODEL_REQUESTS_CELL.exec(cell);
    if (!match) continue;
    sawModelCell = true;
    const entry = lookupPricing(index, match[1]);
    if (!entry) {
      unpricedCells.push(cell);
      continue;
    }
    modelUsd += used * modelRequestCost(entry, profile).total;
  }
  if (sawModelCell) {
    return { usd: modelUsd, basis: 'models', window: 'day', unpricedCells };
  }

  const allowed = allowedModels(index, cells, globalDefaults);
  if (allowed.length === 0) return null;
  const perRequest = allowed.map((entry) => modelRequestCost(entry, profile));
  const priciest = perRequest.reduce((a, b) => (b.total > a.total ? b : a));
  // A reasoner's output multiplier can make it priciest per request without
  // having the highest $/counted-token, so the token rate is its own max.
  const blended = perRequest.reduce(
    (max, cost) => Math.max(max, blendedPerTokenUsd(cost)),
    0,
  );

  const tokensDay = usage['chat.tokensPerDay'];
  if (tokensDay) {
    return {
      usd: tokensDay.used * blended,
      basis: 'tokens',
      window: 'day',
      unpricedCells,
    };
  }
  const tokensMonth = usage['chat.tokensPerMonth'];
  if (tokensMonth) {
    return {
      usd: tokensMonth.used * blended,
      basis: 'tokens',
      window: 'month',
      unpricedCells,
    };
  }
  const messages = usage['chat.messagesPerDay'];
  if (messages) {
    return {
      usd: messages.used * priciest.total,
      basis: 'messages',
      window: 'day',
      unpricedCells,
    };
  }
  return null;
}
