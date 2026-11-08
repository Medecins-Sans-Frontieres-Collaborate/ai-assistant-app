import type { OpenAIModel } from '@/types/openai';

/**
 * Per-request admission ceilings derived from a deployment's throughput.
 *
 * Why this exists: Azure admits a pay-as-you-go request only if its
 * ESTIMATED cost — prompt tokens plus the requested `max_tokens` — fits in
 * the deployment's tokens-per-minute (TPM) limit. A request estimated above
 * the whole limit is rejected with a 429 on every attempt, no matter how
 * long the caller waits, and it consumes no tokens. On 2026-11-06 prod
 * `gpt-6-astra` (250K TPM) rejected every turn carrying two large
 * spreadsheets for exactly this reason, and each turn ended on a fallback
 * model. A model's catalog context window (`maxLength`) is a property of the
 * model; this ceiling is a property of how much of it the deployment can
 * actually admit, so the effective window is the smaller of the two.
 *
 * Units (verified against ARM `properties.rateLimits`): one capacity unit of
 * a Standard-family SKU is 1,000 TPM, for Azure OpenAI and Foundry
 * third-party models alike. Provisioned (PTU) and batch capacity are not
 * TPM and yield no ceiling.
 */

/** Tokens per minute granted by one capacity unit of a Standard-family SKU. */
export const TOKENS_PER_MINUTE_PER_CAPACITY_UNIT = 1_000;

/**
 * Fraction of the TPM limit a single request may plan to use. Azure's
 * admission estimate is character-based and the app's own count (tiktoken)
 * differs from it, so the plan keeps a margin instead of aiming at the limit.
 */
export const ADMISSION_HEADROOM = 0.9;

/**
 * Smallest output reservation the clamp will leave a model. Below this an
 * answer is not useful, so a deployment too small for it keeps whatever
 * output limit fits rather than reserving nothing.
 */
const MIN_OUTPUT_TOKENS = 1_024;

/** SKUs whose capacity is measured in TPM (see module docblock). */
const TPM_METERED_SKUS: ReadonlySet<string> = new Set([
  'standard',
  'globalstandard',
  'datazonestandard',
]);

/**
 * Converts a deployment's SKU and capacity into its tokens-per-minute limit.
 *
 * @param sku - ARM SKU name, e.g. "GlobalStandard" (case-insensitive).
 * @param capacity - ARM `sku.capacity`.
 * @returns The TPM limit, or undefined when the SKU is not TPM-metered
 *          (provisioned, batch, unknown) or the capacity is missing/invalid.
 */
export function deploymentTokensPerMinute(
  sku: string | undefined,
  capacity: number | undefined,
): number | undefined {
  if (!sku || !TPM_METERED_SKUS.has(sku.toLowerCase())) return undefined;
  if (typeof capacity !== 'number' || !Number.isFinite(capacity)) {
    return undefined;
  }
  if (capacity <= 0) return undefined;
  return Math.floor(capacity * TOKENS_PER_MINUTE_PER_CAPACITY_UNIT);
}

/**
 * The largest request (prompt + output reservation) a deployment with this
 * TPM limit should be sent, after headroom.
 *
 * @param tokensPerMinute - The deployment's TPM limit.
 * @returns Admissible tokens per request (always >= 0).
 */
export function admissibleRequestTokens(tokensPerMinute: number): number {
  return Math.max(0, Math.floor(tokensPerMinute * ADMISSION_HEADROOM));
}

/**
 * Returns `model` with its context window (and, only when unavoidable, its
 * output limit) reduced so a full-size request fits the deployment's
 * admission ceiling. Every budget that reads `maxLength` — history trimming,
 * inline-file sizing, document chunking — then plans requests Azure will
 * actually admit.
 *
 * Pure: never mutates `model`. A model already within the ceiling comes back
 * with only `tokensPerMinute` stamped, so a capacity increase in Azure lifts
 * the clamp with no code change.
 *
 * @param model - Catalog or discovered model config.
 * @param tokensPerMinute - The serving deployment's TPM limit; undefined
 *        (unknown or not TPM-metered) returns `model` unchanged.
 * @returns The effective model config.
 *
 * @example
 * // 250K TPM deployment of a 272K-window model with a 32K output limit:
 * applyAdmissionCeiling(astra, 250_000);
 * // => { ...astra, maxLength: 225_000, tokenLimit: 32_000, tokensPerMinute: 250_000 }
 */
export function applyAdmissionCeiling<
  T extends Pick<OpenAIModel, 'maxLength' | 'tokenLimit' | 'tokensPerMinute'>,
>(model: T, tokensPerMinute: number | undefined): T {
  if (
    tokensPerMinute === undefined ||
    !Number.isFinite(tokensPerMinute) ||
    tokensPerMinute <= 0
  ) {
    return model;
  }
  const ceiling = admissibleRequestTokens(tokensPerMinute);
  if (model.maxLength <= ceiling) {
    return { ...model, tokensPerMinute };
  }
  // Keep the output reservation unless it would leave no room for input:
  // then split the ceiling so neither side is starved.
  const tokenLimit =
    model.tokenLimit < ceiling / 2
      ? model.tokenLimit
      : Math.max(Math.min(MIN_OUTPUT_TOKENS, ceiling), Math.floor(ceiling / 4));
  return { ...model, maxLength: ceiling, tokenLimit, tokensPerMinute };
}

/**
 * Model calls a native code-interpreter turn is planned for.
 *
 * On the Responses path the interpreter loop runs inside ONE request, but
 * every step is a separate model call that re-sends the whole context: the
 * call that writes code, one per further execution, and the call that
 * answers. All of them land in the same minute against the same TPM limit.
 * Measured 2026-11-07 on gpt-5.6-luna (250K TPM): reported prompt tokens
 * track (runs + 1) x context, and typical file turns run code once or
 * twice — a ~120K-token context exhausted the deployment mid-turn. Three
 * calls covers the common case; a longer loop on a small deployment can
 * still be rate-limited, and the client fallback then takes over.
 */
export const NATIVE_INTERPRETER_PLANNED_MODEL_CALLS = 3;

/**
 * Splits a deployment's TPM limit across the model calls one turn makes,
 * giving the throughput each call may plan to use. Feed the result to
 * applyAdmissionCeiling to size a context that every call of the turn can
 * be admitted with.
 *
 * @param tokensPerMinute - The deployment's TPM limit; undefined passes through.
 * @param plannedModelCalls - Calls the turn is planned for (>= 1; lower
 *        values are treated as 1).
 * @returns The per-call TPM share, or undefined when the limit is unknown.
 *
 * @example
 * perCallTokensPerMinute(250_000, 3); // => 83_333
 */
export function perCallTokensPerMinute(
  tokensPerMinute: number | undefined,
  plannedModelCalls: number,
): number | undefined {
  if (tokensPerMinute === undefined) return undefined;
  const calls = Math.max(1, Math.floor(plannedModelCalls));
  return Math.floor(tokensPerMinute / calls);
}
