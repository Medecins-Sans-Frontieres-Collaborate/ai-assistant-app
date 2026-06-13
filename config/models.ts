/**
 * Environment-specific model configurations
 * Defines default model, fallback chain, and model availability per environment
 */
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

export type Environment = 'localhost' | 'dev' | 'prod';

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
