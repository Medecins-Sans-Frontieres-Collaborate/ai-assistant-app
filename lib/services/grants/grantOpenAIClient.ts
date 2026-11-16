/**
 * Azure OpenAI client factory for the grant extraction pipeline.
 *
 * Authenticates as the application identity (Entra ID); the identity needs
 * Cognitive Services OpenAI User on the account behind the endpoint. There is
 * no key path: the pipeline's account has local (key) authentication disabled.
 */
import { getCognitiveServicesTokenProvider } from '@/lib/utils/server/azure/cognitiveServicesAuth';

import { AzureOpenAI } from 'openai';

const DEFAULT_API_VERSION = '2024-10-21';

function openaiEndpoint(): string {
  return (
    process.env.GRANT_PIPELINE_OPENAI_ENDPOINT ||
    process.env.AZURE_OPENAI_ENDPOINT ||
    ''
  );
}

function openaiDeployment(): string {
  return (
    process.env.GRANT_PIPELINE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_DEPLOYMENT_ID ||
    'gpt-4o'
  );
}

function apiVersion(): string {
  return process.env.OPENAI_API_VERSION || DEFAULT_API_VERSION;
}

/**
 * Builds the grant pipeline's Azure OpenAI client.
 *
 * @returns A client authenticated with the application identity
 * @throws Error when no endpoint is configured (GRANT_PIPELINE_OPENAI_ENDPOINT
 *   or AZURE_OPENAI_ENDPOINT)
 */
export function getGrantOpenAIClient(): AzureOpenAI {
  const ep = openaiEndpoint();
  if (!ep) {
    throw new Error(
      'No Azure OpenAI endpoint configured. Set GRANT_PIPELINE_OPENAI_ENDPOINT or AZURE_OPENAI_ENDPOINT.',
    );
  }

  return new AzureOpenAI({
    endpoint: ep,
    apiKey: '', // Suppress the SDK's ambient OPENAI_API_KEY default.
    baseURL: '', // Derive from the explicit Azure endpoint, never OPENAI_BASE_URL.
    apiVersion: apiVersion(),
    azureADTokenProvider: getCognitiveServicesTokenProvider(),
  });
}

export function getDeployment(): string {
  return openaiDeployment();
}
