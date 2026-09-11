'use client';

import { useMemo } from 'react';

import {
  EMISSIONS_ASSUMPTIONS,
  estimateCO2Grams,
} from '@/lib/utils/shared/emissions';
import { estimateTokensFromText } from '@/lib/utils/shared/tokenEstimate';

import { OpenAIModel, getModelSizeClass } from '@/types/openai';

export interface RunEstimateInput {
  /** The model the run will use (the workspace's selected model). */
  model: OpenAIModel | null | undefined;
  /** Source text the run will send. Every pass re-sends it — see `passes`. */
  sourceText: string;
  /**
   * How many model calls the chosen settings imply. Agentic translation is
   * analysis + translation + up to N review rounds; a quick run is one call.
   */
  passes: number;
  /**
   * Expected completion size relative to the source, when the run rewrites it
   * (a translation is roughly source-length; an extraction is far shorter).
   */
  completionRatio?: number;
}

export interface RunEstimate {
  gCO2e: number;
  passes: number;
}

/**
 * Pre-flight estimate for a workflow run
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §5d).
 *
 * The one place emissions data is genuinely ACTIONABLE rather than
 * reportorial: quick vs agentic, and the review-round count, differ by several
 * times, and the user picks between them BEFORE spending anything. Chat has no
 * equivalent — there the cost is known only afterwards.
 *
 * Rough by construction, and the UI says so with a "~": token counts come from
 * the chars/4 heuristic, and each pass is assumed to re-send the whole source,
 * which is what the orchestrators actually do.
 */
export function useRunEstimate({
  model,
  sourceText,
  passes,
  completionRatio = 1,
}: RunEstimateInput): RunEstimate | null {
  return useMemo(() => {
    if (!sourceText.trim() || passes <= 0) return null;
    const sourceTokens = estimateTokensFromText(sourceText);
    if (sourceTokens <= 0) return null;

    const { gCO2e } = estimateCO2Grams({
      // Every pass carries the source again — that is why a workflow run is
      // prompt-dominated where a chat turn is not.
      promptTokens: sourceTokens * passes,
      completionTokens: Math.round(sourceTokens * completionRatio * passes),
      sizeClass: getModelSizeClass(model ?? {}),
      isDedicatedReasoner: model?.modelType === 'reasoning',
      // Region is left at the default grid, as in the model selector's
      // comparative figure: workflow routes use region-blind home clients.
      region: null,
    });
    return { gCO2e, passes };
  }, [model, sourceText, passes, completionRatio]);
}

/** Rounds a pre-flight figure for display; always shown with a "~". */
export function formatEstimate(grams: number): string {
  if (grams < 1) return grams.toFixed(1);
  if (grams < 10) return grams.toFixed(1);
  return `${Math.round(grams)}`;
}

/** Re-exported so callers can note which assumption set produced a figure. */
export const ESTIMATE_ASSUMPTIONS_VERSION =
  EMISSIONS_ASSUMPTIONS.assumptionsVersion;
