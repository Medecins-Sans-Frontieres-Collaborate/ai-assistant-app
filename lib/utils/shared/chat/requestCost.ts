/**
 * Per-request USD at list price for the chat cost readouts
 * (docs/CHAT_COST_CHIP.md). The same arithmetic the limits admin uses
 * (costEstimator.ts), applied to ONE request's real token counts:
 *
 *  - Global Standard list rate (deployment multiplier 1 — the deployment SKU
 *    is not on the request), no cached-input discount (no telemetry for it),
 *  - reasoning / thinking tokens are invisible in the counts, so the
 *    estimator's output multipliers stand in for them,
 *  - one request = one model call: the token counts already cover every
 *    tool round, so no round multiplier.
 *
 * Every figure is an upper bound at stated assumptions, never a bill.
 * Anything billed outside model tokens (web search, code execution,
 * transcription, speech, translation, document indexing) is NOT here, and
 * every surface that shows these numbers says so.
 *
 * Shared (client + server safe): no React, no feature flags.
 */
import {
  type ExclusionReason,
  estimateRequestCost,
  findPricing,
  formatUsdParts,
  outputMultiplierFor,
} from '@/lib/utils/shared/costEstimator';

import type { OpenAIModel } from '@/types/openai';

/** `invalid-usage`: the stored counts were not finite non-negative numbers. */
export type RequestCostExclusion = ExclusionReason | 'invalid-usage';

export type RequestCostResult =
  | { usd: number; excluded?: undefined }
  | { usd?: undefined; excluded: RequestCostExclusion };

export interface RequestCostInput {
  /** The model that actually served (usage.modelId), or the conversation's model for back-calculated turns. */
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  reasoningEffort?: string;
  /** The live (discovery-aware) model list; the static registry is the fallback. */
  liveModels: readonly OpenAIModel[];
}

/** USD for one request, or why it cannot be priced. */
export function estimateRequestUsd(input: RequestCostInput): RequestCostResult {
  const lookup = findPricing(input.modelId, input.liveModels);
  if ('excluded' in lookup) return { excluded: lookup.excluded };
  try {
    const cost = estimateRequestCost(lookup.pricing, {
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      outputMultiplier: outputMultiplierFor(
        lookup.model,
        input.reasoningEffort,
      ),
      deploymentMultiplier: 1,
      cachedShare: 0,
      toolRounds: 1,
    });
    return { usd: cost.total };
  } catch {
    return { excluded: 'invalid-usage' };
  }
}

/**
 * Display label for a USD figure: "$0.00", "< $0.01" (via `lessThan`, so the
 * prefix can be localized) or the cent-rounded amount. Rounding happens here
 * and nowhere earlier — see costEstimator.ts on why.
 */
export function formatUsdLabel(
  value: number,
  locale: string,
  lessThan: (amount: string) => string,
): string {
  const parts = formatUsdParts(value, locale);
  if (parts.kind === 'zero') {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
    }).format(0);
  }
  if (parts.kind === 'lessThan') return lessThan(parts.text);
  return parts.text;
}
