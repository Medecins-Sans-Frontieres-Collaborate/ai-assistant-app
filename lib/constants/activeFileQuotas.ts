import type { OpenAIModel } from '@/types/openai';

/** Files above this token count cannot be pinned (medium-tier baseline; large-context models override via getActiveFileBudgets). */
export const ACTIVE_FILE_PIN_TOKEN_LIMIT = 50_000;

/** Files above this token count are rejected from becoming active files entirely (medium-tier baseline). */
export const ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT = 90_000;

/** Cumulative token budget per conversation session for active file injection (medium-tier baseline). */
export const ACTIVE_FILE_SESSION_QUOTA = 300_000;

/** Floor for the per-turn active-file injection budget. */
export const ACTIVE_FILE_PER_TURN_MIN = 2_000;

/** Global ceiling for the per-turn budget across all tiers. */
export const ACTIVE_FILE_PER_TURN_MAX = 100_000;

/**
 * Default fraction of the model's remaining input budget (after reserving
 * output) to spend on active-file injection each turn. Medium-tier baseline;
 * large-context models override via getActiveFileBudgets.
 */
export const ACTIVE_FILE_PER_TURN_FRACTION = 0.3;

/**
 * Hard byte cap on the per-file `processedContent.content` we will persist.
 * Belt-and-suspenders alongside `ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT` — the
 * token estimate can be missing or wrong, but the byte length cannot lie.
 * 1MB per file × ≤5 files per conversation keeps active-file content under
 * the localStorage budget for a typical browser even on a heavy session.
 */
export const ACTIVE_FILE_CONTENT_MAX_BYTES = 1_000_000;

export interface ActiveFileBudgets {
  pinLimit: number;
  activationLimit: number;
  perTurnCap: number;
  fraction: number;
  sessionQuota: number;
}

const MID_TIER: ActiveFileBudgets = {
  pinLimit: ACTIVE_FILE_PIN_TOKEN_LIMIT,
  activationLimit: ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT,
  perTurnCap: 55_000,
  fraction: ACTIVE_FILE_PER_TURN_FRACTION,
  sessionQuota: ACTIVE_FILE_SESSION_QUOTA,
};

const LARGE_TIER: ActiveFileBudgets = {
  pinLimit: 75_000,
  activationLimit: 120_000,
  perTurnCap: 80_000,
  fraction: 0.35,
  sessionQuota: 400_000,
};

/**
 * Active-file budgets tiered by the model's input context window.
 * - Mid tier (<160k): mainstream 128k models (GPT-4o, etc.) — uses the
 *   exported baseline constants above.
 * - Large tier (≥160k): 200k+ context models (Claude, etc.) — gets a
 *   bigger per-turn cap, looser pin/activation limits, and a higher
 *   session quota proportional to the extra headroom.
 *
 * Client-side validation continues to use the baseline constants directly
 * (they represent the most permissive *guaranteed* limits across tiers);
 * server-side enforcement uses this helper so the larger tiers actually
 * benefit from the extra room their context window provides.
 */
export function getActiveFileBudgets(
  model: Pick<OpenAIModel, 'maxLength'> | undefined | null,
): ActiveFileBudgets {
  const maxLength = model?.maxLength ?? 0;
  return maxLength >= 160_000 ? LARGE_TIER : MID_TIER;
}
