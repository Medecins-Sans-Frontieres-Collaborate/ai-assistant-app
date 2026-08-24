import type { EvalModelMeta } from './models';
import type { TokenUsage } from './types';

/**
 * USD cost of one call from config/models.json `pricing`.
 * Cached prompt tokens are billed at cachedInputPer1M when known, otherwise
 * at the full input rate (conservative).
 */
export function calculateCostUsd(
  usage: TokenUsage,
  meta: EvalModelMeta,
): number {
  const p = meta.pricing;
  if (!p) return 0;
  const uncached = Math.max(0, usage.promptTokens - usage.cachedPromptTokens);
  const cachedRate = p.cachedInputPer1M ?? p.inputPer1M;
  return (
    (uncached * p.inputPer1M +
      usage.cachedPromptTokens * cachedRate +
      usage.completionTokens * p.outputPer1M) /
    1_000_000
  );
}

export function hasPricing(meta: EvalModelMeta): boolean {
  return Boolean(meta.pricing);
}

/**
 * candidate / goal. A goal cost of 0 (no pricing) yields Infinity when the
 * candidate cost > 0 so the over-budget guard trips loudly instead of hiding.
 */
export function costRatio(candidateUsd: number, goalUsd: number): number {
  if (goalUsd === 0) return candidateUsd === 0 ? 0 : Number.POSITIVE_INFINITY;
  return candidateUsd / goalUsd;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`;
}
