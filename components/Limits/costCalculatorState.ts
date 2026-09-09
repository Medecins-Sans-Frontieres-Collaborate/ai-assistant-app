/**
 * Pure state, validation and derivation for the limits cost calculator
 * (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4c).
 *
 * No React and no flag reads, so it is unit-tested under the node config
 * (__tests__/components/limits/costCalculatorState.test.ts — a `.ts` test
 * under __tests__/components/limits is the one such path the node config
 * matches). The component (CostCalculator.tsx) only holds the text fields and
 * renders what these helpers derive.
 *
 * The cross-check resolves the DRAFT's cells client-side with the pure
 * resolver against a synthetic principal: the estimator's caps therefore
 * reflect unsaved edits (the UI says so), never the saved policy — and in
 * scoped mode only the scoped admin's own overrides, because the scoped GET
 * never returns the global defaults.
 */
import type { ResolvedLimit } from '@/lib/services/limits/resolver';
import {
  counterCellName,
  resolveLimit,
  resolveModelCells,
} from '@/lib/services/limits/resolver';
import type { LimitEntry, LimitsPolicy } from '@/lib/services/limits/types';
import type { Principal } from '@/lib/services/shared/principalMatching';

import { PricingIndex, lookupPricing } from '@/lib/utils/app/limitsPricing';
import {
  COST_ASSUMPTIONS,
  CostPeriod,
  Deployment,
  EstimateInput,
  EstimateWithCaps,
  ProfileKey,
  deploymentMultiplierFor,
  estimateSpendWithCaps,
  exclusionForModelId,
} from '@/lib/utils/shared/costEstimator';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

import { getLimitDefinition } from '@/config/limits';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CalculatorProfileChoice = ProfileKey | 'custom';

/** One mix row; `share` is the percent as typed (weights — any scale). */
export interface MixRow {
  modelId: string;
  share: string;
}

/**
 * Text fields stay strings so a half-typed value never snaps to a number
 * under the admin's cursor; parseCalculatorState turns them into an
 * EstimateInput or a list of issues.
 */
export interface CalculatorState {
  users: string;
  requests: string;
  period: CostPeriod;
  profile: CalculatorProfileChoice;
  promptTokens: string;
  completionTokens: string;
  /** 0..100, custom profile only. */
  cachedSharePercent: string;
  mix: MixRow[];
  deployment: Deployment;
  toolRounds: string;
  /** Keep byom-/local- rows in the mix (they still price at $0, marked excluded). */
  includeByom: boolean;
}

export function initialCalculatorState(
  defaultModelId: string,
): CalculatorState {
  return {
    users: '100',
    requests: '20',
    period: 'day',
    profile: 'typical',
    promptTokens: '1000',
    completionTokens: '500',
    cachedSharePercent: '0',
    mix: mixPresetDefault(defaultModelId),
    deployment: 'global',
    toolRounds: String(COST_ASSUMPTIONS.defaultToolRounds),
    includeByom: false,
  };
}

// ---------------------------------------------------------------------------
// Mix presets
// ---------------------------------------------------------------------------

/** The default model alone. */
export function mixPresetDefault(modelId: string): MixRow[] {
  return [{ modelId, share: '100' }];
}

/** Equal shares over a family's members (percent, two decimals). */
export function mixPresetFamily(memberIds: readonly string[]): MixRow[] {
  if (memberIds.length === 0) return [];
  const share = String(Math.round((100 / memberIds.length) * 100) / 100);
  return memberIds.map((modelId) => ({ modelId, share }));
}

/** Adds a model row (equal to the others' mean share) unless present. */
export function addMixRow(mix: readonly MixRow[], modelId: string): MixRow[] {
  if (mix.some((row) => row.modelId.toLowerCase() === modelId.toLowerCase())) {
    return [...mix];
  }
  const parsed = mix
    .map((row) => Number(row.share))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const mean =
    parsed.length > 0 ? parsed.reduce((a, b) => a + b, 0) / parsed.length : 100;
  return [...mix, { modelId, share: String(Math.round(mean * 100) / 100) }];
}

// ---------------------------------------------------------------------------
// Validation → EstimateInput
// ---------------------------------------------------------------------------

export type CalculatorField =
  | 'users'
  | 'requests'
  | 'promptTokens'
  | 'completionTokens'
  | 'tokens'
  | 'cachedShare'
  | 'toolRounds'
  | 'mix'
  | 'share';

export interface CalculatorIssue {
  field: CalculatorField;
  /** For `share`: the offending row. */
  modelId?: string;
}

export type ParsedCalculator =
  | {
      ok: true;
      input: EstimateInput;
      /** byom/local rows left out because `includeByom` is off. */
      droppedRows: string[];
    }
  | { ok: false; issues: CalculatorIssue[] };

function num(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return Number.NaN;
  return Number(trimmed);
}

function isUserBilled(modelId: string): boolean {
  const reason = exclusionForModelId(modelId);
  return reason === 'byom' || reason === 'local';
}

/**
 * Validates the form and builds the estimator input. Every problem is
 * reported at once (the UI lists them next to the results). Rules: users an
 * integer ≥ 0, requests finite ≥ 0; a custom profile needs finite ≥ 0 token counts
 * whose sum is > 0 (a token cap divided by zero tokens is meaningless) and
 * a cached share in 0..100; tool rounds an integer ≥ 1; at least one mix row
 * after the byom drop, each share finite ≥ 0 with a positive sum.
 */
export function parseCalculatorState(state: CalculatorState): ParsedCalculator {
  const issues: CalculatorIssue[] = [];

  const users = num(state.users);
  if (!Number.isInteger(users) || users < 0) issues.push({ field: 'users' });
  const requests = num(state.requests);
  if (!Number.isFinite(requests) || requests < 0) {
    issues.push({ field: 'requests' });
  }

  let profile: EstimateInput['profile'] = 'typical';
  if (state.profile === 'custom') {
    const promptTokens = num(state.promptTokens);
    const completionTokens = num(state.completionTokens);
    const cachedPercent = num(state.cachedSharePercent);
    const promptOk = Number.isFinite(promptTokens) && promptTokens >= 0;
    const completionOk =
      Number.isFinite(completionTokens) && completionTokens >= 0;
    if (!promptOk) issues.push({ field: 'promptTokens' });
    if (!completionOk) issues.push({ field: 'completionTokens' });
    if (promptOk && completionOk && promptTokens + completionTokens <= 0) {
      issues.push({ field: 'tokens' });
    }
    if (
      !Number.isFinite(cachedPercent) ||
      cachedPercent < 0 ||
      cachedPercent > 100
    ) {
      issues.push({ field: 'cachedShare' });
    }
    profile = {
      promptTokens,
      completionTokens,
      cachedShare: cachedPercent / 100,
    };
  } else {
    profile = state.profile;
  }

  const toolRounds = num(state.toolRounds);
  if (!Number.isInteger(toolRounds) || toolRounds < 1) {
    issues.push({ field: 'toolRounds' });
  }

  const droppedRows: string[] = [];
  const rows: Array<{ modelId: string; share: number }> = [];
  for (const row of state.mix) {
    if (!row.modelId) continue;
    if (!state.includeByom && isUserBilled(row.modelId)) {
      droppedRows.push(row.modelId);
      continue;
    }
    const share = num(row.share);
    if (!Number.isFinite(share) || share < 0) {
      issues.push({ field: 'share', modelId: row.modelId });
      continue;
    }
    rows.push({ modelId: row.modelId, share });
  }
  if (rows.length === 0) {
    issues.push({ field: 'mix' });
  } else if (rows.reduce((sum, row) => sum + row.share, 0) <= 0) {
    issues.push({ field: 'mix' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    droppedRows,
    input: {
      users,
      requestsPerUserPerPeriod: requests,
      period: state.period,
      models: rows,
      profile,
      deployment: state.deployment,
      toolRounds,
    },
  };
}

// ---------------------------------------------------------------------------
// Deployment applicability
// ---------------------------------------------------------------------------

/**
 * False when every mix model that resolves to a price is Marketplace-billed
 * or legacy-serverless (the deployment multiplier is "n/a" for all of them,
 * so the selector is greyed). True when nothing resolves — there is nothing
 * to grey for.
 */
export function deploymentApplicable(
  mix: readonly MixRow[],
  index: PricingIndex | null,
): boolean {
  if (!index) return true;
  let resolved = 0;
  for (const row of mix) {
    const entry = lookupPricing(index, row.modelId);
    if (!entry) continue;
    resolved += 1;
    if (deploymentMultiplierFor(entry.pricing, 'dataZone').applicable) {
      return true;
    }
  }
  return resolved === 0;
}

/**
 * The deployment the estimate and its disclosure actually assume. While the
 * selector is greyed (deploymentApplicable false) the stored choice is kept
 * for when an Azure-billed model rejoins the mix, but it must not be STATED:
 * the estimator prices every such model at ×1 regardless, so the disclosure
 * would otherwise assert "×1.1 Data Zone" over rows that all say "multiplier
 * n/a". Global (×1) is the only honest assumption for that mix.
 */
export function effectiveDeployment(
  state: Pick<CalculatorState, 'mix' | 'deployment'>,
  index: PricingIndex | null,
): Deployment {
  return deploymentApplicable(state.mix, index) ? state.deployment : 'global';
}

// ---------------------------------------------------------------------------
// Draft-based cells for the cross-check
// ---------------------------------------------------------------------------

/**
 * The synthetic principal the draft is resolved for. It matches no override
 * target (the synthetic policy carries none), so what resolves is exactly
 * the entries handed in as `defaults`.
 */
export const DRAFT_PRINCIPAL: Principal = {
  userId: 'cost-calculator-draft',
  attributes: [],
  groupIds: [],
};

/**
 * A policy whose ONLY content is the caps to check against: the global
 * defaults draft, or (scoped mode) the union of the admin's own override
 * entries. Not schema-parsed — a draft mid-edit must not throw here; the
 * resolver copes with any LimitEntry shape the editors produce.
 */
export function synthesizeCapsPolicy(
  caps: readonly LimitEntry[],
): LimitsPolicy {
  return {
    version: 1,
    defaults: [...caps],
    overrides: [],
    delegations: [],
    mode: 'enforce',
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    updatedBy: 'cost-calculator-draft',
    updatedAt: '',
  };
}

const CAP_KEYS = {
  allowed: 'model.allowed',
  requests: 'model.requests',
  messages: 'chat.messagesPerDay',
  tokensDay: 'chat.tokensPerDay',
  tokensMonth: 'chat.tokensPerMonth',
} as const;

function seriesOf(
  modelId: string,
  index: PricingIndex | null,
): string | undefined {
  const fromIndex = index
    ? lookupPricing(index, modelId)?.model.series
    : undefined;
  if (fromIndex) return fromIndex;
  const wanted = modelId.toLowerCase();
  for (const model of Object.values(OpenAIModels) as OpenAIModel[]) {
    if (model.id?.toLowerCase() === wanted) return model.series;
  }
  return undefined;
}

/**
 * `cellsByModelId` for estimateSpendWithCaps: EVERY conjunctive cell a
 * request on each mix model must satisfy — model.allowed and model.requests
 * (model + family cells) plus the unqualified message and token caps — the
 * same recipe the estimator's own tests use.
 */
export function cellsByModelIdFor(
  caps: readonly LimitEntry[],
  modelIds: readonly string[],
  index: PricingIndex | null,
): Record<string, ResolvedLimit[]> {
  const policy = synthesizeCapsPolicy(caps);
  const allowed = getLimitDefinition(CAP_KEYS.allowed);
  const requests = getLimitDefinition(CAP_KEYS.requests);
  const messages = getLimitDefinition(CAP_KEYS.messages);
  const tokensDay = getLimitDefinition(CAP_KEYS.tokensDay);
  const tokensMonth = getLimitDefinition(CAP_KEYS.tokensMonth);
  if (!allowed || !requests || !messages || !tokensDay || !tokensMonth) {
    throw new Error('[cost] limits catalog is missing a cost-relevant key');
  }
  const out: Record<string, ResolvedLimit[]> = {};
  for (const modelId of modelIds) {
    const series = seriesOf(modelId, index);
    out[modelId] = [
      ...resolveModelCells(allowed, policy, DRAFT_PRINCIPAL, modelId, series),
      ...resolveModelCells(requests, policy, DRAFT_PRINCIPAL, modelId, series),
      resolveLimit(messages, policy, DRAFT_PRINCIPAL),
      resolveLimit(tokensDay, policy, DRAFT_PRINCIPAL),
      resolveLimit(tokensMonth, policy, DRAFT_PRINCIPAL),
    ];
  }
  return out;
}

/** One row of the cross-check's "caps considered" list. */
export interface CrossCheckCell {
  /** counterCellName — matches `bindingCells` from the estimator. */
  cell: string;
  limitKey: string;
  modelId?: string;
  series?: string;
  value: ResolvedLimit['value'];
  unit: ResolvedLimit['unit'];
  window: ResolvedLimit['window'];
}

/**
 * The distinct cells the cross-check consulted, unqualified first, then
 * family, then model — deduplicated by counter cell name so a family cell
 * shared by two mix members appears once.
 */
export function crossCheckCells(
  cellsByModelId: Readonly<Record<string, readonly ResolvedLimit[]>>,
): CrossCheckCell[] {
  const seen = new Map<string, CrossCheckCell>();
  for (const cells of Object.values(cellsByModelId)) {
    for (const cell of cells) {
      const name = counterCellName(cell);
      if (seen.has(name)) continue;
      seen.set(name, {
        cell: name,
        limitKey: cell.limitKey,
        ...(cell.modelId ? { modelId: cell.modelId } : {}),
        ...(cell.series ? { series: cell.series } : {}),
        value: cell.value,
        unit: cell.unit,
        window: cell.window,
      });
    }
  }
  const rank = (c: CrossCheckCell) => (c.modelId ? 2 : c.series ? 1 : 0);
  return [...seen.values()].sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// Running the estimate
// ---------------------------------------------------------------------------

export interface CalculatorRun {
  parsed: Extract<ParsedCalculator, { ok: true }>;
  result: EstimateWithCaps;
  cellsByModelId: Record<string, ResolvedLimit[]>;
  /** Requests per user per DAY the inputs imply — what the day caps compare against. */
  impliedRequestsPerUserPerDay: number;
}

/**
 * Parses the form and, when valid, runs the cap-aware estimate against the
 * draft's caps. `null` when the form has issues (see parseCalculatorState).
 * The deployment handed to the estimator is the EFFECTIVE one
 * (effectiveDeployment), so `parsed.input.deployment`, the result's
 * `assumptions.deployment` and the "multiplier n/a" chips all agree with a
 * greyed selector.
 */
export function runCalculator(
  state: CalculatorState,
  models: readonly OpenAIModel[],
  caps: readonly LimitEntry[],
  index: PricingIndex | null,
): CalculatorRun | { issues: CalculatorIssue[] } {
  const parsed = parseCalculatorState({
    ...state,
    deployment: effectiveDeployment(state, index),
  });
  if (!parsed.ok) return { issues: parsed.issues };
  const rows = parsed.input.models;
  const modelIds =
    typeof rows === 'string' ? [rows] : rows.map((row) => row.modelId);
  const cellsByModelId = cellsByModelIdFor(caps, modelIds, index);
  const result = estimateSpendWithCaps(parsed.input, models, cellsByModelId);
  return {
    parsed,
    result,
    cellsByModelId,
    impliedRequestsPerUserPerDay:
      parsed.input.requestsPerUserPerPeriod /
      COST_ASSUMPTIONS.periodDays[parsed.input.period],
  };
}
