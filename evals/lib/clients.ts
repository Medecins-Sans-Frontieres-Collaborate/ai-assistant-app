/**
 * Thin model clients for the eval harness.
 *
 * Mirrors ServiceContainer's construction (Entra bearer via
 * DefaultAzureCredential, Foundry OpenAI-compat endpoint, AnthropicFoundry)
 * but reads env directly so a half-configured .env.local still works.
 */
import { envString, loadEvalEnv } from './env';

import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import {
  AzureCliCredential,
  DefaultAzureCredential,
  type TokenCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import OpenAI, { AzureOpenAI } from 'openai';

export interface EvalClients {
  azureOpenAI: AzureOpenAI;
  openAICompat: OpenAI;
  anthropic?: AnthropicFoundry;
}

let clients: EvalClients | null = null;

/**
 * EVAL_AUTH=cli (default) → `az login` identity. EVAL_AUTH=default → the
 * app's DefaultAzureCredential chain, which also honours AZURE_CLIENT_SECRET
 * from the env file — note that a stale secret there makes the chain fail
 * hard instead of falling through to the CLI.
 */
function buildCredential(): TokenCredential {
  const mode = envString('EVAL_AUTH', 'cli');
  if (mode === 'default') return new DefaultAzureCredential();
  if (mode !== 'cli')
    throw new Error(`EVAL_AUTH must be "cli" or "default", got "${mode}"`);
  // Foundry lives in the app tenant; the CLI's default tenant may differ.
  return new AzureCliCredential({ tenantId: envString('AZURE_TENANT_ID') });
}

export function getEvalClients(): EvalClients {
  if (clients) return clients;
  loadEvalEnv();

  const tokenProvider = getBearerTokenProvider(
    buildCredential(),
    'https://cognitiveservices.azure.com/.default',
  );

  const foundry = envString('AZURE_AI_FOUNDRY_ENDPOINT');
  const accountBase = foundry?.replace(/\/api\/projects\/.*$/, '');
  const azureOpenAIEndpoint =
    envString('AZURE_OPENAI_ENDPOINT') ??
    accountBase?.replace('.services.ai.azure.com', '.openai.azure.com');
  if (!azureOpenAIEndpoint) {
    throw new Error(
      'Set AZURE_OPENAI_ENDPOINT or AZURE_AI_FOUNDRY_ENDPOINT in .env.local (or EVAL_ENV_FILE)',
    );
  }

  const entraPreferredFetch: typeof fetch = async (input, init) => {
    try {
      const token = await tokenProvider();
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    } catch {
      return fetch(input, init);
    }
  };

  clients = {
    azureOpenAI: new AzureOpenAI({
      endpoint: azureOpenAIEndpoint,
      azureADTokenProvider: tokenProvider,
      apiVersion: envString('OPENAI_API_VERSION', '2025-04-01-preview'),
    }),
    openAICompat: new OpenAI({
      baseURL:
        envString('AZURE_AI_FOUNDRY_OPENAI_ENDPOINT') ??
        `${accountBase}/openai/v1/`,
      apiKey: envString('OPENAI_API_KEY', 'placeholder'),
      fetch: entraPreferredFetch,
    }),
    anthropic: accountBase
      ? new AnthropicFoundry({
          azureADTokenProvider: async () => tokenProvider(),
          baseURL: `${accountBase}/anthropic`,
        })
      : undefined,
  };
  return clients;
}
