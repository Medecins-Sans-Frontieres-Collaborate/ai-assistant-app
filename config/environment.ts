/**
 * Environment Configuration & Validation
 *
 * Centralized, type-safe environment variable configuration using Zod.
 * All environment variables should be accessed through this module to ensure type safety.
 */
import { z } from 'zod';

/**
 * Environment enum
 */
const EnvironmentEnum = z.enum(['localhost', 'dev', 'staging', 'beta', 'prod']);

/**
 * Server-side environment schema (includes secrets)
 */
const serverEnvSchema = z.object({
  // Node environment
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  // Azure Authentication
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),

  // Azure OpenAI
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_VERSION: z.string().default('2025-04-01-preview'),
  OPENAI_EMBEDDING_DEPLOYMENT: z.string().default('text-embedding'),

  // Azure AI Foundry
  AZURE_AI_FOUNDRY_ENDPOINT: z.string().url().optional(),
  AZURE_AI_FOUNDRY_OPENAI_ENDPOINT: z.string().url().optional(),

  // Azure Blob Storage (uses Entra ID authentication via DefaultAzureCredential)
  AZURE_BLOB_STORAGE_NAME: z.string().optional(),
  AZURE_BLOB_STORAGE_NAME_EU: z.string().optional(),
  AZURE_BLOB_STORAGE_CONTAINER: z.string().optional(),
  AZURE_BLOB_STORAGE_IMAGE_CONTAINER: z.string().optional(),
  STORAGE_RESOURCE_ID: z.string().optional(),
  STORAGE_DATA_SOURCE_CONTAINER: z.string().optional(),

  // Azure Search (uses Entra ID authentication via DefaultAzureCredential)
  SEARCH_ENDPOINT: z.string().url().optional(),
  SEARCH_INDEX: z.string().optional(),
  SEARCH_SKILLSET: z.string().default('rag-skillset'),
  SEARCH_DATASOURCE: z.string().optional(),
  SEARCH_INDEXER: z.string().optional(),
  SEARCH_ENDPOINT_API_KEY: z.string().optional(), // Legacy: Used by OpenAI data_sources feature in documentSummary.ts
  ALLOW_INDEX_DOWNTIME: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),

  // Application Configuration
  DEFAULT_MODEL: z.string().default('gpt-5.2-chat'),
  DEFAULT_USE_KNOWLEDGE_BASE: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  FORCE_LOGOUT_ON_REFRESH_FAILURE: z.string().default('true'),

  // NextAuth
  AUTH_SECRET: z.string().optional(),
  NEXTAUTH_SECRET: z.string().optional(),
  NEXTAUTH_URL: z.string().url().optional(),

  // Application Insights (OpenTelemetry)
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),

  // LaunchDarkly
  LAUNCHDARKLY_SDK_KEY: z.string().optional(),
  LAUNCHDARKLY_CLIENT_ID: z.string().optional(),

  // Build Information
  GITHUB_SHA: z.string().optional(),
  BUILD_ID: z.string().optional(),
  NEXT_PUBLIC_EMAIL: z.string().email().optional(),

  // System Prompt Configuration
  NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_TEMPERATURE: z.string().default('0.5'),

  // Application Environment
  NEXT_PUBLIC_ENV: EnvironmentEnum.default('localhost'),
  NEXT_PUBLIC_BUILD: z.string().optional(),

  // Feature Flags
  systemPromptmaxLength: z
    .string()
    .transform((val) => Number(val) || 500)
    .optional(),
});

/**
 * Client-side environment schema (only NEXT_PUBLIC_ vars)
 */
const clientEnvSchema = z.object({
  NEXT_PUBLIC_ENV: EnvironmentEnum.default('localhost'),
  NEXT_PUBLIC_BUILD: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT: z.string().optional(),
  NEXT_PUBLIC_DEFAULT_TEMPERATURE: z.string().default('0.5'),
  NEXT_PUBLIC_EMAIL: z.string().email().optional(),
  LAUNCHDARKLY_CLIENT_ID: z.string().optional(),
});

/**
 * Validate and parse environment variables
 */
function validateEnv() {
  // Check if we're on the server or client
  const isServer = typeof window === 'undefined';

  if (isServer) {
    // Server-side: validate all environment variables
    const parsed = serverEnvSchema.safeParse(process.env);

    if (!parsed.success) {
      console.error('❌ Invalid environment variables:');
      console.error(parsed.error.flatten().fieldErrors);
      throw new Error('Invalid environment variables');
    }

    return parsed.data;
  } else {
    // Client-side: only validate NEXT_PUBLIC_ variables
    const parsed = clientEnvSchema.safeParse(process.env);

    if (!parsed.success) {
      console.error('❌ Invalid client environment variables:');
      console.error(parsed.error.flatten().fieldErrors);
      throw new Error('Invalid client environment variables');
    }

    return parsed.data;
  }
}

/**
 * Validated environment variables
 *
 * Use this object instead of process.env for type safety
 */
export const env = validateEnv() as ServerEnv & ClientEnv;

/**
 * Type exports
 */
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type Environment = z.infer<typeof EnvironmentEnum>;

/**
 * Helper functions
 */
export const isProduction = () => env.NEXT_PUBLIC_ENV === 'prod';
export const isDevelopment = () =>
  env.NEXT_PUBLIC_ENV === 'localhost' || env.NEXT_PUBLIC_ENV === 'dev';
export const isStaging = () => env.NEXT_PUBLIC_ENV === 'staging';
export const isBeta = () => env.NEXT_PUBLIC_ENV === 'beta';

/**
 * Get current environment
 */
export const getCurrentEnvironment = (): Environment => env.NEXT_PUBLIC_ENV;
