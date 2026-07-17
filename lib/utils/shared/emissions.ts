/**
 * Emissions estimation for chat token usage.
 *
 * Pure + shared (no server-only imports): the server uses it to stamp
 * EstimatedCO2Grams onto TokenUsage log events; the client uses it to render
 * the Settings "Usage & impact" section from locally accumulated RAW token
 * counts. Because the client stores raw counts and computes CO2e at display
 * time, editing config/emissions.json adjusts every estimate retroactively.
 *
 * ── Grounding for the default assumptions (config/emissions.json) ─────────
 * These are deliberately order-of-magnitude estimates, not measurements:
 *  - Energy per token: public figures put a median frontier-model query at
 *    ~0.24–0.34 Wh (Google's Gemini median 0.24 Wh, 2025; OpenAI's stated
 *    0.34 Wh/query) over roughly 500–800 output tokens → ~0.4 Wh per 1k
 *    tokens for a "standard" model. nano/mini scale down and "large" scales
 *    up by rough parameter-count ratios.
 *  - promptTokenWeight 0.15: prefill is batched and far cheaper per token
 *    than autoregressive decode.
 *  - Reasoning: OpenAI reasoning tokens are INCLUDED in completion_tokens
 *    (and Anthropic thinking tokens in output_tokens), so the multipliers
 *    here model only longer-sequence attention/KV overhead — keep them
 *    modest or reasoning cost gets double-counted.
 *  - PUE 1.15 ≈ Azure fleet average (1.12–1.18).
 *  - Grid intensity (gCO2e/kWh): US grid ≈ 370 (EPA eGRID), EU ≈ 230 (EEA
 *    EU-27). "default" covers requests served by the region-blind default
 *    clients (currently the US/home account).
 */
import emissionsConfig from '@/config/emissions.json';
import { z } from 'zod';

const regionSchema = z.object({
  US: z.number().positive(),
  EU: z.number().positive(),
  default: z.number().positive(),
});

const emissionsAssumptionsSchema = z.object({
  assumptionsVersion: z.string().min(1),
  pue: z.number().min(1),
  gridIntensity: regionSchema,
  whPer1kTokens: z.object({
    nano: z.number().positive(),
    mini: z.number().positive(),
    standard: z.number().positive(),
    large: z.number().positive(),
  }),
  promptTokenWeight: z.number().min(0).max(1),
  reasoningEffortMultipliers: z.object({
    none: z.number().min(0),
    minimal: z.number().min(0),
    low: z.number().min(0),
    medium: z.number().min(0),
    high: z.number().min(0),
  }),
  dedicatedReasoningMultiplier: z.number().min(0),
  equivalences: z.object({
    smartphoneChargeGrams: z.number().positive(),
  }),
});

export type EmissionsAssumptions = z.infer<typeof emissionsAssumptionsSchema>;

/** Validated at module load so a malformed edit fails fast (models.json pattern). */
export const EMISSIONS_ASSUMPTIONS: EmissionsAssumptions = (() => {
  const parsed = emissionsAssumptionsSchema.safeParse(emissionsConfig);
  if (!parsed.success) {
    throw new Error(
      `[emissions] Invalid config/emissions.json: ${parsed.error.message}`,
    );
  }
  return parsed.data;
})();

export type ModelSizeClass = keyof EmissionsAssumptions['whPer1kTokens'];

/** The assumption-set identifier, for display + log traceability. */
export const ASSUMPTIONS_VERSION = EMISSIONS_ASSUMPTIONS.assumptionsVersion;

/** gCO2e of one smartphone charge — the relatable equivalence in the UI. */
export const SMARTPHONE_CHARGE_GRAMS =
  EMISSIONS_ASSUMPTIONS.equivalences.smartphoneChargeGrams;

export interface EmissionsInput {
  promptTokens: number;
  completionTokens: number;
  sizeClass: ModelSizeClass;
  /** modelType === 'reasoning' (o3, DeepSeek-R1): always-on deep reasoning. */
  isDedicatedReasoner: boolean;
  /** The effort actually applied to the request, when tunable. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Resolved chat region; null/undefined = default (home) clients. */
  region: 'US' | 'EU' | null | undefined;
}

export interface EmissionsEstimate {
  gCO2e: number;
  energyWh: number;
  assumptionsVersion: string;
}

/**
 * Estimates the CO2e for one request (or one aggregated bucket of requests
 * sharing model/region/effort — the formula is linear in tokens).
 */
export function estimateCO2Grams(input: EmissionsInput): EmissionsEstimate {
  const a = EMISSIONS_ASSUMPTIONS;
  const effectiveTokens =
    input.promptTokens * a.promptTokenWeight + input.completionTokens;
  const effortMultiplier =
    a.reasoningEffortMultipliers[input.reasoningEffort ?? 'none'];
  const dedicatedMultiplier = input.isDedicatedReasoner
    ? a.dedicatedReasoningMultiplier
    : 1;
  const energyWh =
    (effectiveTokens / 1000) *
    a.whPer1kTokens[input.sizeClass] *
    effortMultiplier *
    dedicatedMultiplier *
    a.pue;
  const intensity = a.gridIntensity[input.region ?? 'default'];
  return {
    gCO2e: (energyWh * intensity) / 1000,
    energyWh,
    assumptionsVersion: a.assumptionsVersion,
  };
}
