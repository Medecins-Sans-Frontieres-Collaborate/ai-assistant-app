/**
 * Environment-specific model configurations
 * Defines default model, fallback chain, and model availability per environment
 */
import { versionRank } from '@/lib/utils/app/modelSeries';

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
 * every fallback. Agent and non-streaming reasoning models are intentionally
 * excluded — their behavior differs too much to substitute silently.
 */
const DEFAULT_FALLBACK_CHAIN: string[] = [
  OpenAIModelID.GPT_5_2_CHAT,
  OpenAIModelID.GPT_5_2,
  OpenAIModelID.GPT_5_MINI,
  OpenAIModelID.DEEPSEEK_V3_1,
];

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
  OpenAIModelID.GPT_5_4,
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
 * Unless the ring config sets an explicit `defaultModel` override, the
 * default is DYNAMIC: the latest (highest versionRank) standard-variant GPT
 * among `availableModels` — pass the live/served model list where you have
 * one so the default tracks actual deployments. Without a list it resolves
 * against the vetted static list, so callers that run before/without
 * discovery still get a ring-safe answer.
 */
export function getDefaultModel(availableModels?: OpenAIModel[]): string {
  const override = getModelConfig().defaultModel;
  if (override) return override;

  let latest: OpenAIModel | undefined;
  for (const model of availableModels ?? getStaticModelList()) {
    if (model.series !== 'gpt' || model.variant !== 'standard') continue;
    if (model.isDisabled || isModelDisabled(model.id)) continue;
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
 * Gets the error-fallback chain for the current environment. The (dynamic)
 * default model always leads: it's the ring's most vetted choice, so a
 * failing model falls back to it before the static cross-provider chain.
 */
export function getFallbackChain(): string[] {
  const chain = getModelConfig().fallbackChain ?? DEFAULT_FALLBACK_CHAIN;
  const defaultModel = getDefaultModel();
  return [defaultModel, ...chain.filter((id) => id !== defaultModel)];
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

/**
 * Returns the next model to fall back to after a model-specific failure.
 *
 * Walks the environment's fallback chain and returns the first model that
 * exists, is enabled, and is not in `excludeModelIds` (the model that just
 * failed plus any fallbacks already attempted). Returns null when the chain
 * is exhausted — callers should surface the original error at that point.
 */
export function getFallbackModel(
  excludeModelIds: string[],
): OpenAIModel | null {
  for (const modelId of getFallbackChain()) {
    if (excludeModelIds.includes(modelId)) continue;
    if (isModelDisabled(modelId)) continue;

    const model = OpenAIModels[modelId as OpenAIModelID];
    if (model && !model.isDisabled) {
      return model;
    }
  }
  return null;
}
