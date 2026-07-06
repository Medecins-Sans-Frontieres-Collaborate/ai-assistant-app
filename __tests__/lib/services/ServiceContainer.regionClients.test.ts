import { ServiceContainer } from '@/lib/services/ServiceContainer';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub credentials so no real Azure auth is attempted at container init.
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  getBearerTokenProvider: () => async () => 'test-token',
}));

const mockEnv = vi.hoisted(
  () =>
    ({
      NODE_ENV: 'test',
      AZURE_OPENAI_ENDPOINT: 'https://default.cognitiveservices.azure.com/',
      AZURE_AI_FOUNDRY_ENDPOINT:
        'https://default.services.ai.azure.com/api/projects/default',
      OPENAI_API_KEY: 'default-key',
      OPENAI_API_VERSION: '2025-04-01-preview',
    }) as Record<string, string | undefined>,
);
vi.mock('@/config/environment', () => ({ env: mockEnv }));

afterEach(() => {
  ServiceContainer.reset();
  delete mockEnv.AZURE_AI_FOUNDRY_ENDPOINT_EU;
  delete mockEnv.AZURE_OPENAI_ENDPOINT_EU;
  delete mockEnv.OPENAI_API_KEY_EU;
});

describe('ServiceContainer.getChatClientsForRegion', () => {
  it('builds a full EU client set from the regional Foundry endpoint + key', () => {
    mockEnv.AZURE_AI_FOUNDRY_ENDPOINT_EU =
      'https://acct-eu.services.ai.azure.com/api/projects/default';
    mockEnv.OPENAI_API_KEY_EU = 'eu-key';

    const clients =
      ServiceContainer.getInstance().getChatClientsForRegion('EU');

    expect(clients.azureOpenAIClient).toBeDefined();
    expect(clients.anthropicFoundryClient).toBeDefined();
    expect(clients.openAIClient).toBeDefined();
    expect(String(clients.openAIClient!.baseURL)).toContain(
      'acct-eu.services.ai.azure.com/openai/v1',
    );
  });

  it('omits the OpenAI-compatible client without a region-scoped API key (account-scoped keys)', () => {
    mockEnv.AZURE_AI_FOUNDRY_ENDPOINT_EU =
      'https://acct-eu.services.ai.azure.com/api/projects/default';

    const clients =
      ServiceContainer.getInstance().getChatClientsForRegion('EU');

    expect(clients.openAIClient).toBeUndefined();
    // Entra-authenticated clients don't need a key and are still built.
    expect(clients.azureOpenAIClient).toBeDefined();
    expect(clients.anthropicFoundryClient).toBeDefined();
  });

  it('prefers an explicit AZURE_OPENAI_ENDPOINT_{REGION} over derivation', () => {
    mockEnv.AZURE_AI_FOUNDRY_ENDPOINT_EU =
      'https://acct-eu.services.ai.azure.com/api/projects/default';
    mockEnv.AZURE_OPENAI_ENDPOINT_EU =
      'https://explicit-eu.cognitiveservices.azure.com/';

    const clients =
      ServiceContainer.getInstance().getChatClientsForRegion('EU');

    expect(String(clients.azureOpenAIClient!.baseURL)).toContain(
      'explicit-eu.cognitiveservices.azure.com',
    );
  });

  it('returns an empty set (with a warning) when nothing is configured for the region', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clients =
      ServiceContainer.getInstance().getChatClientsForRegion('US');
    warnSpy.mockRestore();

    expect(clients.azureOpenAIClient).toBeUndefined();
    expect(clients.openAIClient).toBeUndefined();
    expect(clients.anthropicFoundryClient).toBeUndefined();
  });

  it('caches the built set per region', () => {
    mockEnv.AZURE_AI_FOUNDRY_ENDPOINT_EU =
      'https://acct-eu.services.ai.azure.com/api/projects/default';

    const container = ServiceContainer.getInstance();
    expect(container.getChatClientsForRegion('EU')).toBe(
      container.getChatClientsForRegion('EU'),
    );
  });
});
