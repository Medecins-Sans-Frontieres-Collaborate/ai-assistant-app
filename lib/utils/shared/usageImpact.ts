/**
 * Prices RAW token-usage buckets as CO2e and list-price USD.
 *
 * The client stores usage as raw token counts keyed
 * `modelId|region|effort` (settingsStore `tokenUsageStats`, and the per-day
 * `dailyTokenUsage` ledger behind personal budgets). Everything that turns
 * those counts into a figure goes through here, so Settings › Usage & Impact
 * and the budget meters can never disagree about what a bucket cost.
 *
 * Shared (client + server safe): no React, no feature flags.
 */
import { estimateRequestUsd } from '@/lib/utils/shared/chat/requestCost';
import { estimateCO2Grams } from '@/lib/utils/shared/emissions';

import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  getModelSizeClass,
} from '@/types/openai';

/** Raw counts of one usage bucket. */
export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export type UsageRegion = 'US' | 'EU' | 'default';
export type UsageEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface ParsedUsageKey {
  modelId: string;
  region: UsageRegion;
  effort: UsageEffort;
}

/** Splits a `modelId|region|effort` bucket key back into its parts. */
export function parseTokenUsageKey(key: string): ParsedUsageKey {
  const [modelId, region, effort] = key.split('|');
  return {
    modelId,
    region: (region ?? 'default') as UsageRegion,
    effort: (effort ?? 'none') as UsageEffort,
  };
}

export interface BucketImpact extends ParsedUsageKey {
  /** The model the bucket resolved to, when it is still known. */
  model: OpenAIModel | undefined;
  gCO2e: number;
  /** Undefined when the model has no list price (or the counts are invalid). */
  usd: number | undefined;
}

/**
 * CO2e and list-price USD for one bucket.
 *
 * The live (discovery-aware) model list is the best source of size class and
 * reasoning flags; the static registry is the fallback, then defaults, for
 * retired ids no longer in either.
 *
 * @param key - Bucket key, `modelId|region|effort`.
 * @param counts - The bucket's raw token counts.
 * @param liveModels - The served model list.
 */
export function estimateBucketImpact(
  key: string,
  counts: Pick<TokenCounts, 'promptTokens' | 'completionTokens'>,
  liveModels: readonly OpenAIModel[],
): BucketImpact {
  const parsed = parseTokenUsageKey(key);
  const model =
    liveModels.find((m) => m.id === parsed.modelId) ??
    OpenAIModels[parsed.modelId as OpenAIModelID];
  const reasoningEffort = parsed.effort === 'none' ? undefined : parsed.effort;
  const { gCO2e } = estimateCO2Grams({
    promptTokens: counts.promptTokens,
    completionTokens: counts.completionTokens,
    sizeClass: getModelSizeClass(model ?? {}),
    isDedicatedReasoner: model?.modelType === 'reasoning',
    reasoningEffort,
    region: parsed.region === 'default' ? null : parsed.region,
  });
  const cost = estimateRequestUsd({
    modelId: parsed.modelId,
    promptTokens: counts.promptTokens,
    completionTokens: counts.completionTokens,
    reasoningEffort,
    liveModels,
  });
  return { ...parsed, model, gCO2e, usd: cost.usd };
}

export interface UsageImpactTotals {
  gCO2e: number;
  /** Sum over the buckets that could be priced. */
  usd: number;
}

/**
 * Totals for a set of buckets. Buckets without a list price add carbon but
 * no dollars — the same rule the Usage & Impact cost tile follows.
 */
export function sumUsageImpact(
  buckets: Readonly<Record<string, TokenCounts>>,
  liveModels: readonly OpenAIModel[],
): UsageImpactTotals {
  let gCO2e = 0;
  let usd = 0;
  for (const [key, counts] of Object.entries(buckets)) {
    const impact = estimateBucketImpact(key, counts, liveModels);
    gCO2e += impact.gCO2e;
    usd += impact.usd ?? 0;
  }
  return { gCO2e, usd };
}
