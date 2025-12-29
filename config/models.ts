/**
 * Environment-specific model configurations
 * Defines default model and model availability per environment
 */

export type Environment = 'localhost' | 'dev' | 'prod';

export interface EnvironmentConfig {
  defaultModel: string;
  disabledModels?: string[]; // Models that should not be available in this environment
}

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

  if (env === 'production' || env === 'prod') {
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
