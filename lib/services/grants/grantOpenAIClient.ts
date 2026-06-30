/**
 * Azure OpenAI client factory for the grant extraction pipeline.
 */
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

function openaiKey(): string {
  return (
    process.env.GRANT_PIPELINE_OPENAI_KEY || process.env.OPENAI_API_KEY || ''
  );
}

function apiVersion(): string {
  return process.env.OPENAI_API_VERSION || DEFAULT_API_VERSION;
}

export function getGrantOpenAIClient(): AzureOpenAI {
  const ep = openaiEndpoint();
  if (!ep) {
    throw new Error(
      'No Azure OpenAI endpoint configured. Set GRANT_PIPELINE_OPENAI_ENDPOINT or AZURE_OPENAI_ENDPOINT.',
    );
  }

  const key = openaiKey();
  if (!key) {
    throw new Error(
      'No Azure OpenAI API key configured. Set GRANT_PIPELINE_OPENAI_KEY or OPENAI_API_KEY.',
    );
  }

  return new AzureOpenAI({
    endpoint: ep,
    apiKey: key,
    apiVersion: apiVersion(),
  });
}

export function getDeployment(): string {
  return openaiDeployment();
}
