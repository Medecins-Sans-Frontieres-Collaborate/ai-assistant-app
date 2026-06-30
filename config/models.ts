/**
 * Environment-specific model configurations
 * Defines default model, fallback chain, and model availability per environment
 */
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

export type Environment = 'localhost' | 'dev' | 'beta' | 'prod';

export interface EnvironmentConfig {
  defaultModel: string;
  fallbackChain?: string[]; // Error-fallback order; defaults to DEFAULT_FALLBACK_CHAIN
  disabledModels?: string[]; // Models that should not be available in this environment
}

/**
 * Ordered chain of models to fall back to when a chat request fails with a
 * model-specific error. The default model comes first (most reliable), then
 * progressively different models/providers so an outage affecting one
 * deployment doesn't take out every fallback. Agent and non-streaming
 * reasoning models are intentionally excluded — their behavior differs too
 * much to substitute silently.
 */
const DEFAULT_FALLBACK_CHAIN: string[] = [
  OpenAIModelID.GPT_5_2_CHAT,
  OpenAIModelID.GPT_5_2,
  OpenAIModelID.GPT_5_MINI,
  OpenAIModelID.DEEPSEEK_V3_1,
];

const modelConfigs: Record<Environment, EnvironmentConfig> = {
  localhost: {
    defaultModel: 'gpt-5.2-chat',
    // All models available in localhost
  },
  dev: {
    defaultModel: 'gpt-5.2-chat',
    // All models available in dev
  },
  beta: {
    defaultModel: 'gpt-5.2-chat',
    // Beta shares a Foundry instance with prod but is its own visibility ring:
    // models under test are visible here while still disabled in prod below.
    disabledModels: [],
  },
  prod: {
    defaultModel: 'gpt-5.2-chat',
    disabledModels: [], // All current models available in production
  },
};

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
  // independently.
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
 * Gets the default model for the current environment
 */
export function getDefaultModel(): string {
  return getModelConfig().defaultModel;
}

/**
 * Checks if a model is disabled in the current environment
 */
export function isModelDisabled(modelId: string): boolean {
  const config = getModelConfig();
  return config.disabledModels?.includes(modelId) ?? false;
}

/**
 * Gets the error-fallback chain for the current environment
 */
export function getFallbackChain(): string[] {
  return getModelConfig().fallbackChain ?? DEFAULT_FALLBACK_CHAIN;
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
