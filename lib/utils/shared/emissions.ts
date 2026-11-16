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
 *    up by rough parameter-count ratios. "xl" (2026-09, gpt-6-astra) is a
 *    further 2x over "large": OpenAI publishes no per-query energy for
 *    Astra, so the ratio is a proxy from its list price (2x GPT-5.6 Sol)
 *    and its recurrent-depth architecture (several passes over a shared
 *    layer stack per token, i.e. more decode compute than a single-pass
 *    model of similar parameter count). Revisit when a measurement exists.
 *  - promptTokenWeight 0.15: prefill is batched and far cheaper per token
 *    than autoregressive decode.
 *  - Reasoning: OpenAI reasoning tokens are INCLUDED in completion_tokens
 *    (and Anthropic thinking tokens in output_tokens), so the multipliers
 *    here model only longer-sequence attention/KV overhead — keep them
 *    modest or reasoning cost gets double-counted.
 *  - typicalRequest 1000/500: ~1k prompt ≈ a short system prompt plus a few
 *    turns of context; 500 completion ≈ the 500–800-output-token public
 *    medians the whPer1kTokens figures were derived from.
 *  - activityGramsPerHour: per-hour carbon of everyday digital activities,
 *    for the "your usage ≈ N seconds of X" equivalents. Netflix HD 45 (36–55
 *    operational, Digital Equivalencies Matrix), Zoom camera-on 50
 *    (operational central; true range is very wide), web browsing 25
 *    (operational), Spotify audio ~1 (full-chain consumer calculators).
 *    Mixed accounting boundaries — fine for an order-of-magnitude comparison,
 *    which is all the UI claims.
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
    xl: z.number().positive(),
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
    activityGramsPerHour: z.object({
      netflixHd: z.number().positive(),
      zoomCall: z.number().positive(),
      webBrowsing: z.number().positive(),
      spotifyAudio: z.number().positive(),
    }),
  }),
  typicalRequest: z.object({
    promptTokens: z.number().positive(),
    completionTokens: z.number().positive(),
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
 * The part of an assumption set the estimate itself depends on. Narrower than
 * {@link EmissionsAssumptions} so a set that comes from somewhere other than
 * config/emissions.json — the assumptions a delivered emissions report was
 * produced with, or a what-if — can be passed without inventing the display
 * settings it does not carry.
 */
export type EmissionsFactors = Pick<
  EmissionsAssumptions,
  | 'assumptionsVersion'
  | 'pue'
  | 'gridIntensity'
  | 'whPer1kTokens'
  | 'promptTokenWeight'
  | 'reasoningEffortMultipliers'
  | 'dedicatedReasoningMultiplier'
>;

/**
 * The estimate under an EXPLICIT assumption set. This is the one formula:
 * {@link estimateCO2Grams} is this with the app's current assumptions, and the
 * analytics emissions dashboard calls it with whichever set the reader picks,
 * so a report can be recalculated without a second copy of the arithmetic.
 */
export function estimateCO2GramsWith(
  factors: EmissionsFactors,
  input: EmissionsInput,
): EmissionsEstimate {
  const effectiveTokens =
    input.promptTokens * factors.promptTokenWeight + input.completionTokens;
  const effortMultiplier =
    factors.reasoningEffortMultipliers[input.reasoningEffort ?? 'none'];
  const dedicatedMultiplier = input.isDedicatedReasoner
    ? factors.dedicatedReasoningMultiplier
    : 1;
  const energyWh =
    (effectiveTokens / 1000) *
    factors.whPer1kTokens[input.sizeClass] *
    effortMultiplier *
    dedicatedMultiplier *
    factors.pue;
  const intensity = factors.gridIntensity[input.region ?? 'default'];
  return {
    gCO2e: (energyWh * intensity) / 1000,
    energyWh,
    assumptionsVersion: factors.assumptionsVersion,
  };
}

/**
 * Estimates the CO2e for one request (or one aggregated bucket of requests
 * sharing model/region/effort — the formula is linear in tokens).
 */
export function estimateCO2Grams(input: EmissionsInput): EmissionsEstimate {
  return estimateCO2GramsWith(EMISSIONS_ASSUMPTIONS, input);
}

export type EmissionsTier = 'low' | 'moderate' | 'high';

const SIZE_CLASS_TIER: Record<ModelSizeClass, EmissionsTier> = {
  nano: 'low',
  mini: 'low',
  standard: 'moderate',
  large: 'high',
  xl: 'high',
};

/**
 * Tier from size class; dedicated reasoners bump one tier because the
 * always-on reasoning multiplier materially raises per-request energy.
 */
export function getEmissionsTier(
  sizeClass: ModelSizeClass,
  isDedicatedReasoner: boolean,
): EmissionsTier {
  const tier = SIZE_CLASS_TIER[sizeClass];
  if (!isDedicatedReasoner) return tier;
  return tier === 'low' ? 'moderate' : 'high';
}

/**
 * Estimate for one "typical request" (assumption-defined token counts), used
 * for the comparative per-model number in the model selector. Region is left
 * at the default grid on purpose — the number is comparative, and regional
 * intensity is second-order; UI copy notes actual impact varies by region.
 */
export function estimateTypicalRequestCO2(
  sizeClass: ModelSizeClass,
  isDedicatedReasoner: boolean,
  reasoningEffort?: EmissionsInput['reasoningEffort'],
): EmissionsEstimate {
  return estimateCO2Grams({
    promptTokens: EMISSIONS_ASSUMPTIONS.typicalRequest.promptTokens,
    completionTokens: EMISSIONS_ASSUMPTIONS.typicalRequest.completionTokens,
    sizeClass,
    isDedicatedReasoner,
    reasoningEffort,
    region: null,
  });
}

export type ActivityKey =
  keyof EmissionsAssumptions['equivalences']['activityGramsPerHour'];

export interface ActivityEquivalent {
  key: ActivityKey;
  /** Seconds of the activity with the same carbon footprint as `gCO2e`. */
  seconds: number;
}

/**
 * Expresses a CO2e amount as durations of everyday digital activities:
 * seconds = 3600 × gCO2e / activityGramsPerHour. Same-carbon comparison
 * against published per-hour activity footprints (see the header JSDoc for
 * the comparator grounding) — order-of-magnitude, like every figure here.
 * Returned in config order; callers label the keys via i18n.
 */
export function estimateActivityEquivalents(
  gCO2e: number,
): ActivityEquivalent[] {
  const activities = EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour;
  return (Object.keys(activities) as ActivityKey[]).map((key) => ({
    key,
    seconds: (3600 * gCO2e) / activities[key],
  }));
}

/**
 * How persistently the floating emissions chip is shown.
 *
 * - `always` — visible whenever the conversation has a non-zero estimate.
 * - `auto`   — fades in when the estimate changes or the user reaches for it
 *              (hover/focus/open), fades out otherwise.
 * - `hidden` — never rendered.
 */
export type EmissionsChipVisibility = 'always' | 'auto' | 'hidden';

/** Today's behavior, so existing users see no change after the migration. */
export const EMISSIONS_CHIP_VISIBILITY_DEFAULT: EmissionsChipVisibility =
  'always';

export const EMISSIONS_CHIP_VISIBILITY_OPTIONS: readonly EmissionsChipVisibility[] =
  ['always', 'auto', 'hidden'] as const;

/** Narrows an arbitrary persisted value to a known mode. */
export function isEmissionsChipVisibility(
  value: unknown,
): value is EmissionsChipVisibility {
  return EMISSIONS_CHIP_VISIBILITY_OPTIONS.includes(
    value as EmissionsChipVisibility,
  );
}

/**
 * What the COLLAPSED chip reads (docs/CHAT_COST_CHIP.md). The popover always
 * carries both figures; this only decides which one earns the pixel.
 *
 * - `emissions` — "2.1 g CO₂e" (default: the status quo).
 * - `cost`      — "$0.03".
 * - `both`      — "2.1 g · $0.03".
 */
export type EmissionsChipLabelMode = 'emissions' | 'cost' | 'both';

export const EMISSIONS_CHIP_LABEL_MODE_DEFAULT: EmissionsChipLabelMode =
  'emissions';

export const EMISSIONS_CHIP_LABEL_MODE_OPTIONS: readonly EmissionsChipLabelMode[] =
  ['emissions', 'cost', 'both'] as const;

export function isEmissionsChipLabelMode(
  value: unknown,
): value is EmissionsChipLabelMode {
  return EMISSIONS_CHIP_LABEL_MODE_OPTIONS.includes(
    value as EmissionsChipLabelMode,
  );
}

/**
 * Long enough to read the figure after a response settles, short enough that
 * the chip stops being furniture.
 */
export const EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS = 4000;

/** Below ~1s the chip would flicker rather than inform. */
export const EMISSIONS_CHIP_AUTOHIDE_MIN_MS = 1000;

/** Past a minute "auto" is indistinguishable from "always". */
export const EMISSIONS_CHIP_AUTOHIDE_MAX_MS = 60_000;

/**
 * Normalizes the stored auto-hide delay. Applied on write *and* on read: a
 * hand-edited localStorage value must not be able to wedge the chip permanently
 * on or off. Non-finite values fall back to the default rather than to a bound,
 * since a corrupt value should not silently become a deliberate-looking choice.
 */
export function clampEmissionsChipAutoHideMs(ms: number): number {
  if (!Number.isFinite(ms)) return EMISSIONS_CHIP_AUTOHIDE_DEFAULT_MS;
  return Math.min(
    EMISSIONS_CHIP_AUTOHIDE_MAX_MS,
    Math.max(EMISSIONS_CHIP_AUTOHIDE_MIN_MS, Math.round(ms)),
  );
}

/** <1 g shows decimals ("0.42"); larger values round to whole grams. */
export const formatGrams = (grams: number): string =>
  grams < 1
    ? grams.toFixed(2)
    : grams < 10
      ? grams.toFixed(1)
      : `${Math.round(grams)}`;

const GRAMS_PER_KILOGRAM = 1000;

/**
 * Grams from which a figure is shown in kilograms. Half a gram under the
 * kilogram, because that is where {@link formatGrams} would start printing
 * "1000": the switch is made on what would be DISPLAYED, not the raw value.
 */
const KILOGRAM_DISPLAY_FROM_GRAMS = GRAMS_PER_KILOGRAM - 0.5;

export interface Co2eMassParts {
  /** i18n key suffix under `emissions.mass.*`. */
  unit: 'grams' | 'kilograms';
  /** Pre-formatted magnitude in that unit. */
  value: string;
}

/**
 * Three significant figures for a kilogram magnitude ("1.25", "12.5", "125").
 * Each bound sits where the shorter form would round up into the next one, so
 * 9.996 reads "10.0" rather than "10.00".
 */
const formatKilograms = (kilograms: number): string =>
  kilograms < 9.995
    ? kilograms.toFixed(2)
    : kilograms < 99.95
      ? kilograms.toFixed(1)
      : `${Math.round(kilograms)}`;

/**
 * Picks the display unit for a CO2e mass: grams below a kilogram, kilograms
 * from there up, so a month's total reads "12.5 kg" rather than "12500 g".
 * Pure so the rounding rules are testable; components interpolate `value`
 * into the localized `emissions.mass.<unit>` template (see `useCo2eFormat`).
 *
 * @param grams - Mass in grams of CO2e (non-negative).
 * @returns The unit to display in and the magnitude formatted for it.
 * @example co2eMassParts(184)   // { unit: 'grams', value: '184' }
 * @example co2eMassParts(12500) // { unit: 'kilograms', value: '12.5' }
 */
export function co2eMassParts(grams: number): Co2eMassParts {
  if (grams < KILOGRAM_DISPLAY_FROM_GRAMS) {
    return { unit: 'grams', value: formatGrams(grams) };
  }
  return {
    unit: 'kilograms',
    value: formatKilograms(grams / GRAMS_PER_KILOGRAM),
  };
}

export interface ActivityDurationParts {
  /** i18n key suffix under `emissions.duration.*`. */
  unit: 'lessThanSecond' | 'seconds' | 'minutes' | 'hours';
  /** Pre-formatted magnitude ("" for lessThanSecond). */
  value: string;
}

/**
 * Buckets an activity duration into a display unit. Pure so the rounding
 * rules are testable; components interpolate `value` into the localized
 * `emissions.duration.<unit>` template.
 */
export function activityDurationParts(seconds: number): ActivityDurationParts {
  if (seconds < 1) return { unit: 'lessThanSecond', value: '' };
  if (seconds < 90) return { unit: 'seconds', value: `${Math.round(seconds)}` };
  const minutes = seconds / 60;
  if (minutes < 90) {
    return {
      unit: 'minutes',
      value: minutes < 10 ? minutes.toFixed(1) : `${Math.round(minutes)}`,
    };
  }
  const hours = minutes / 60;
  return {
    unit: 'hours',
    value: hours < 10 ? hours.toFixed(1) : `${Math.round(hours)}`,
  };
}
