/**
 * Tests for the grant pipeline's Azure OpenAI client: it authenticates with
 * the application identity and never with an account key, which no longer
 * exists once local auth is disabled on the Foundry account.
 */
import { getGrantOpenAIClient } from '@/lib/services/grants/grantOpenAIClient';

import { resetCognitiveServicesAuthForTests } from '@/lib/utils/server/azure/cognitiveServicesAuth';

import { AzureOpenAI } from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entraTokenProvider = vi.hoisted(() => vi.fn(async () => 'entra-token'));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  getBearerTokenProvider: () => entraTokenProvider,
}));

vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const MANAGED_ENV = [
  'GRANT_PIPELINE_OPENAI_ENDPOINT',
  'GRANT_PIPELINE_OPENAI_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'OPENAI_API_KEY',
] as const;

describe('getGrantOpenAIClient', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetCognitiveServicesAuthForTests();
    for (const name of MANAGED_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    vi.mocked(AzureOpenAI).mockClear();
  });

  afterEach(() => {
    for (const name of MANAGED_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('authenticates with the application identity even when a key is still set', () => {
    process.env.GRANT_PIPELINE_OPENAI_ENDPOINT =
      'https://grants.cognitiveservices.azure.com/';
    process.env.GRANT_PIPELINE_OPENAI_KEY = 'stale-account-key';

    getGrantOpenAIClient();

    expect(AzureOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://grants.cognitiveservices.azure.com/',
        apiKey: '',
        azureADTokenProvider: entraTokenProvider,
      }),
    );
  });

  it('needs no key: an endpoint alone is enough', () => {
    process.env.AZURE_OPENAI_ENDPOINT =
      'https://app.cognitiveservices.azure.com/';

    expect(() => getGrantOpenAIClient()).not.toThrow();
    expect(AzureOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://app.cognitiveservices.azure.com/',
      }),
    );
  });

  it('still refuses to build a client without an endpoint', () => {
    expect(() => getGrantOpenAIClient()).toThrow(
      /GRANT_PIPELINE_OPENAI_ENDPOINT or AZURE_OPENAI_ENDPOINT/,
    );
    expect(AzureOpenAI).not.toHaveBeenCalled();
  });
});
