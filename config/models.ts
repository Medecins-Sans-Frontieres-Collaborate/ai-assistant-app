/**
 * Environment-specific model configurations
 * Defines default model, fallback chain, and model availability per environment
 */
import { versionRank } from '@/lib/utils/app/modelSeries';
import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import {
  OpenAIModel,
  OpenAIModelID,
  OpenAIModels,
  fallbackModelID,
} from '@/types/openai';

export type Environment = 'localhost' | 'dev' | 'beta' | 'prod';

export interface EnvironmentConfig {
  /** Explicit default-model override; when absent the default is DYNAMIC — the latest standard-variant GPT visible in this ring (see getDefaultModel). */
  defaultModel?: string;
  fallbackChain?: string[]; // Error-fallback order; defaults to DEFAULT_FALLBACK_CHAIN
  /**
   * EMERGENCY kill switch only — hides a model in this environment even when
   * deployed. Deliberately empty in normal operation: model availability is
   * controlled by Foundry deployments (+ ui-ring deployment tags), never by
   * code. See docs/MODEL_DISCOVERY_DESIGN.md.
   */
  disabledModels?: string[];
}

/**
 * Ordered chain of models to fall back to when a chat request fails with a
 * model-specific error. getFallbackChain() prepends the ring's (dynamic)
 * default model; this static tail then covers progressively different
 * models/providers so an outage affecting one deployment doesn't take out
 * every fallback. Ordered cheapest-viable-first (cost policy): Mistral sits
 * high deliberately, and the gpt-5.2 deployments are intentionally absent —
 * in EU that deployment actually serves 5.5, so falling back onto it defeats
 * the cost ordering. Agent and non-streaming models are intentionally
 * excluded — their behavior differs too much to substitute silently.
 */
const DEFAULT_FALLBACK_CHAIN: string[] = [
  OpenAIModelID.GPT_5_4,
  OpenAIModelID.MISTRAL_LARGE_3,
  OpenAIModelID.GPT_5_MINI,
  OpenAIModelID.DEEPSEEK_V4_PRO,
];

/**
 * Ordered default-model preference (cost policy). getDefaultModel() picks the
 * first entry that is actually present in the model list it resolves against
 * (and selectable in the caller's region). A ranked list rather than a single
 * id because US and EU are served from different accounts: a candidate
 * missing in one region simply falls through to the next, and finally to the
 * dynamic latest-standard-GPT rule. gpt-5.4 leads because it is deployed in
 * BOTH regions and is the cheaper choice — the gpt-5.2 deployment is NOT
 * (in EU it actually serves 5.5).
 */
const DEFAULT_MODEL_PREFERENCE: string[] = [OpenAIModelID.GPT_5_4];

/**
 * Models excluded from the STATIC (non-discovery) list in beta/prod.
 *
 * This is NOT a rollout control. Model availability is governed by Foundry
 * deployments (+ optional `ui-ring` deployment tags for beta-first testing);
 * when discovery is enabled this list is ignored entirely. It exists only
 * because the static list — served while discovery is off, or as the
 * fallback when discovery errors — cannot verify regional deployments, so an
 * unvetted entry would fail at chat time (the original EU drift bug).
 * Delete this list together with the static-list path once discovery is
 * enabled in every ring.
 */
const STATIC_LIST_EXCLUSIONS: string[] = [
  // gpt-5.4 is deliberately NOT excluded: it is the preferred default
  // (DEFAULT_MODEL_PREFERENCE) and is deployed in both the US and EU
  // accounts, so the static fallback path must be able to resolve it.
  OpenAIModelID.GPT_5_4_NANO,
  OpenAIModelID.GPT_5_3_CHAT,
  OpenAIModelID.GPT_5,
  OpenAIModelID.GPT_5_CHAT,
  OpenAIModelID.GPT_4O,
  OpenAIModelID.GPT_4_1_MINI,
  OpenAIModelID.CLAUDE_OPUS_4_8,
  OpenAIModelID.CLAUDE_SONNET_4_5,
  OpenAIModelID.DEEPSEEK_V3_2,
  OpenAIModelID.MISTRAL_LARGE_3,
  // Catalog-only metadata (2026-07-10): known-model entries added ahead of any
  // deployment so discovery can join them by name instead of synthesizing
  // unknowns. None are part of the beta/prod static offering. grok-* are
  // absent on purpose — they're isDisabled globally, which gates harder than
  // this static-list exclusion.
  OpenAIModelID.GPT_5_1,
  OpenAIModelID.GPT_5_1_CHAT,
  OpenAIModelID.GPT_5_NANO,
  OpenAIModelID.GPT_4_1_NANO,
  OpenAIModelID.GPT_4O_MINI,
  OpenAIModelID.GPT_o4_MINI,
  OpenAIModelID.GPT_o3_MINI,
  OpenAIModelID.GPT_5_5,
  OpenAIModelID.GPT_5_6_SOL,
  OpenAIModelID.GPT_5_6_TERRA,
  OpenAIModelID.GPT_5_6_LUNA,
  OpenAIModelID.MISTRAL_MEDIUM_3_5,
  OpenAIModelID.KIMI_K2_6,
  OpenAIModelID.GPT_CHAT_LATEST,
  OpenAIModelID.CLAUDE_FABLE_5,
  OpenAIModelID.CLAUDE_SONNET_5,
  OpenAIModelID.CLAUDE_OPUS_4_7,
  OpenAIModelID.CLAUDE_OPUS_4_5,
  OpenAIModelID.MISTRAL_MEDIUM_2505,
  OpenAIModelID.MISTRAL_SMALL_2503,
  OpenAIModelID.MINISTRAL_3B,
  OpenAIModelID.DEEPSEEK_R1_0528,
  OpenAIModelID.DEEPSEEK_V4_PRO,
  OpenAIModelID.DEEPSEEK_V4_FLASH,
  OpenAIModelID.LLAMA_4_SCOUT,
  OpenAIModelID.LLAMA_3_3_70B,
];

const modelConfigs: Record<Environment, EnvironmentConfig> = {
  localhost: {
    // All models available in localhost; default resolves dynamically.
  },
  dev: {
    // All models available in dev; default resolves dynamically.
  },
  beta: {
    // No code-level gating: model availability = Foundry deployments. Beta
    // shares a Foundry instance with prod; beta-first testing of a model is
    // done by tagging its deployment `ui-ring: beta` (removed to release to
    // prod). disabledModels stays empty except in emergencies.
  },
  prod: {},
};

/**
 * Rings that serve the vetted static offering when discovery is unavailable
 * (flag off or discovery error). dev/localhost intentionally see the whole
 * catalog on the static path — they point at the dev Foundry account and are
 * where unreleased models are exercised.
 */
const STATIC_EXCLUSION_RINGS: Environment[] = ['beta', 'prod'];

/**
 * The static model list: full catalog minus globally disabled models, minus
 * (in beta/prod) STATIC_LIST_EXCLUSIONS, minus any emergency disabledModels.
 * Served only while discovery is off or as its error fallback.
 */
export function getStaticModelList(): OpenAIModel[] {
  const applyExclusions = STATIC_EXCLUSION_RINGS.includes(
    getCurrentEnvironment(),
  );
  return Object.values(OpenAIModels).filter(
    (m) =>
      !m.isDisabled &&
      !isModelDisabled(m.id) &&
      !(applyExclusions && STATIC_LIST_EXCLUSIONS.includes(m.id)),
  );
}

/**
 * Gets the current environment from process.env
 * Uses NEXT_PUBLIC_ENV which is available on both server and client
 */
export function getCurrentEnvironment(): Environment {
  // Only use NEXT_PUBLIC_ENV to ensure server/client consistency
  const env = process.env.NEXT_PUBLIC_ENV;

  if (env === 'production' || env === 'prod' || env === 'live') {
    return 'prod';
  }

  // Beta is a distinct visibility ring that may share a Foundry instance with
  // prod; each app build carries its own NEXT_PUBLIC_ENV so they gate models
  // independently. `staging` is an alias for the same ring (staging === beta) —
  // it resolves to the beta config rather than being a separate Environment.
  if (env === 'beta' || env === 'staging') {
    return 'beta';
  }

  if (env === 'dev') {
    return 'dev';
  }

  // Default to localhost for development
  return 'localhost';
}

/**
 * Gets the model configuration for the current environment
 */
export function getModelConfig(): EnvironmentConfig {
  const env = getCurrentEnvironment();
  return modelConfigs[env];
}

/**
 * Gets the default model for the current environment.
 *
 * Resolution order:
 *  1. The ring config's explicit `defaultModel` override, when set.
 *  2. The first DEFAULT_MODEL_PREFERENCE entry present in the candidate
 *     pool — the cost-policy pick.
 *  3. The latest (highest versionRank) standard-variant GPT in the pool.
 *  4. fallbackModelID as the last resort.
 *
 * The pool is `availableModels` — pass the live/served model list where you
 * have one so the default tracks actual deployments — or the vetted static
 * list, so callers that run before/without discovery still get a ring-safe
 * answer. Pass `region` where the caller's region is known: US and EU are
 * served from different accounts, so a model that is a fine default in one
 * region may not be selectable in the other.
 */
export function getDefaultModel(
  availableModels?: OpenAIModel[],
  region?: UserRegion | null,
): string {
  const override = getModelConfig().defaultModel;
  if (override) return override;

  const pool = (availableModels ?? getStaticModelList()).filter(
    (m) =>
      !m.isDisabled &&
      !isModelDisabled(m.id) &&
      isModelSelectableInRegion(m, region),
  );

  for (const preferredId of DEFAULT_MODEL_PREFERENCE) {
    if (pool.some((m) => m.id === preferredId)) return preferredId;
  }

  let latest: OpenAIModel | undefined;
  for (const model of pool) {
    if (model.series !== 'gpt' || model.variant !== 'standard') continue;
    if (!latest || versionRank(model) > versionRank(latest)) {
      latest = model;
    }
  }
  return latest?.id ?? fallbackModelID;
}

/**
 * Checks if a model is disabled in the current environment
 */
export function isModelDisabled(modelId: string): boolean {
  const config = getModelConfig();
  return config.disabledModels?.includes(modelId) ?? false;
}

/**
 * Can this model silently substitute for another in the error-fallback
 * chain? Excludes everything whose behavior or routing is not a plain
 * hosted chat model: curated/custom agents (their tools and instructions
 * are the point of choosing them), local-runtime models (a fallback must
 * not ship a deliberately-local conversation to the cloud), custom-source
 * (byom) models (they run under the user's own account, not the app's),
 * and non-streaming models (a streamed turn can't degrade to
 * them). `isAgent` alone does NOT exclude — it's a deployment-mechanism
 * marker (standard models invoked via Foundry's agent service), not "the
 * user picked a curated agent".
 */
export function isFallbackEligible(model: OpenAIModel): boolean {
  return (
    !model.isDisabled &&
    !isModelDisabled(model.id) &&
    model.stream !== false &&
    !model.isCustomAgent &&
    !model.isOrganizationAgent &&
    !model.localRuntime &&
    !model.id.startsWith('byom-') &&
    !model.id.startsWith('org-') &&
    !model.id.startsWith('foundry-') &&
    !model.id.startsWith('custom-')
  );
}

/**
 * Gets the error-fallback chain for the current environment. The (dynamic)
 * default model always leads: it's the ring's most vetted choice, so a
 * failing model falls back to it before the static cross-provider chain.
 *
 * With `availableModels` (the discovery-served list), the chain is fully
 * DYNAMIC: the default resolves against what is actually deployed, static
 * entries that aren't served are dropped, and the tail is extended with the
 * remaining fallback-eligible served models (GPT series first, then other
 * providers, newest first within each) — so the chain still resolves when
 * the static list has rotted out of the ring (e.g. a deprecated deployment).
 */
export function getFallbackChain(
  availableModels?: readonly OpenAIModel[],
): string[] {
  const chain = getModelConfig().fallbackChain ?? DEFAULT_FALLBACK_CHAIN;
  const defaultModel = getDefaultModel(
    availableModels ? [...availableModels] : undefined,
  );
  const ordered = [defaultModel, ...chain.filter((id) => id !== defaultModel)];
  if (!availableModels || availableModels.length === 0) return ordered;

  const availableIds = new Set(availableModels.map((m) => m.id));
  const served = ordered.filter((id) => availableIds.has(id));
  const seen = new Set(served);
  const extras = availableModels
    .filter((m) => !seen.has(m.id) && isFallbackEligible(m))
    .sort((a, b) => {
      const aGpt = a.series === 'gpt' ? 1 : 0;
      const bGpt = b.series === 'gpt' ? 1 : 0;
      if (aGpt !== bGpt) return bGpt - aGpt;
      return versionRank(b) - versionRank(a);
    })
    .map((m) => m.id);
  return [...served, ...extras];
}

/**
 * Detects an Azure OpenAI / Foundry "deployment not found" error — i.e. the
 * requested model has no deployment in the endpoint the request was routed to.
 * This is the signature of a region missing a deployment (e.g. a half-applied
 * infra change), and is the trigger for falling back through the model chain.
 */
export function isDeploymentNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === 'DeploymentNotFound') return true;
  return (
    (e.status === 404 || code === '404') &&
    /deployment.*not\s*found/i.test(message)
  );
}

/** Dynamic-system context for fallback resolution (all optional). */
export interface FallbackModelOptions {
  /**
   * The discovery-served model list. When present, fallback candidates are
   * restricted to models actually served right now and the chain gains a
   * dynamic tail (see getFallbackChain) — pass it wherever a live list
   * exists so the fallback never targets an undeployed model.
   */
  availableModels?: readonly OpenAIModel[];
  /**
   * A default model to try FIRST — typically the user's configured default
   * (or the ring default, which leads the chain anyway). Skipped when it's
   * excluded (the model that just failed), blocked, unserved, or not
   * fallback-eligible.
   */
  preferredDefaultId?: string | null;
  /**
   * The caller's region. Candidates not selectable there (EU users may only
   * use EU-hosted models) are skipped — without this the chain could
   * "rescue" a turn onto a model the request router would then reject.
   */
  userRegion?: UserRegion | null;
}

/**
 * Returns the next model to fall back to after a model-specific failure.
 *
 * Walks the preferred default (if any) then the environment's fallback
 * chain, and returns the first model that exists, is fallback-eligible, and
 * is not in `excludeModelIds` (the model that just failed plus any
 * fallbacks already attempted). Returns null when the chain is exhausted —
 * callers should surface the original error at that point.
 */
export function getFallbackModel(
  excludeModelIds: string[],
  /**
   * Models this specific CALLER may not use, from admin usage limits
   * (docs/LIMITS.md). Without this the fallback chain would route around a
   * per-user model restriction: a model blocked for this caller is still a
   * valid global fallback target, and recordUsage debits the SERVED model —
   * so the limit check and the debit could end up pointing at different
   * models. Absent/empty preserves the previous behaviour exactly.
   */
  blockedModelIds: readonly string[] = [],
  opts: FallbackModelOptions = {},
): OpenAIModel | null {
  const { availableModels, preferredDefaultId, userRegion } = opts;
  const blocked = new Set(blockedModelIds.map((id) => id.toLowerCase()));
  const byId = new Map(availableModels?.map((m) => [m.id, m]) ?? []);
  const hasLiveList = !!availableModels && availableModels.length > 0;

  const candidates = [
    ...(preferredDefaultId ? [preferredDefaultId] : []),
    ...getFallbackChain(availableModels),
  ];

  for (const modelId of candidates) {
    if (excludeModelIds.includes(modelId)) continue;
    if (blocked.has(modelId.toLowerCase())) continue;

    // Served list wins over the static catalog — a discovered model's live
    // entry carries current flags (isDisabled, hostedIn) the catalog lacks.
    // Chain candidates require presence in the live list when one exists;
    // the PREFERRED default may still resolve from the static catalog — the
    // user's persisted choice should rescue a turn even when the served
    // list is momentarily degenerate, and the request path re-validates it.
    const model =
      byId.get(modelId) ??
      (hasLiveList && modelId !== preferredDefaultId
        ? undefined
        : OpenAIModels[modelId as OpenAIModelID]);
    if (!model) continue;
    if (!isFallbackEligible(model)) continue;
    if (userRegion && !isModelSelectableInRegion(model, userRegion)) continue;
    return model;
  }
  return null;
}
