import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import {
  assertSkillDataRegion,
  auxiliaryRegion,
} from '@/lib/services/skills/skillRegion';
import {
  embedSkillTexts,
  searchSkillChunks,
  skillSearchEndpoint,
} from '@/lib/services/skills/skillSearch';

import { env } from '@/config/environment';
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const regionClients = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({
      getChatClientsForRegion: regionClients,
      getAzureOpenAIClient: vi.fn(() => {
        throw new Error('Default client must never be used');
      }),
    }),
  },
}));

const catalog = [{ id: 'gdpr', name: 'GDPR', description: 'Privacy' }];
function client() {
  const create = vi.fn(async () => ({
    choices: [
      {
        message: {
          content: '{"relevantSkills":["gdpr"],"needsWebSearch":false}',
        },
      },
    ],
  }));
  return {
    create,
    client: { chat: { completions: { create } } } as unknown as OpenAI,
  };
}
describe('auxiliary residency', () => {
  afterEach(() => vi.restoreAllMocks());
  it('EU identities cannot be redirected by the client preference; unknown identities are constrained', () => {
    expect(auxiliaryRegion('EU', 'US')).toBe('EU');
    expect(auxiliaryRegion('US', 'EU')).toBe('EU');
    expect(auxiliaryRegion('US')).toBe('US');
    expect(auxiliaryRegion()).toBe('EU');
    expect(auxiliaryRegion(undefined, 'US')).toBe('EU');
  });
  it('shared and skills-only routing use only the explicitly regional client', async () => {
    const unpinned = client();
    const eu = client();
    const resolver = vi.fn(() => eu.client);
    const router = new ToolRouterService(unpinned.client, resolver);
    await router.determineSkills({
      messages: [],
      currentMessage: 'privacy',
      skillCatalog: catalog,
      region: 'EU',
    });
    await router.determineTool({
      messages: [],
      currentMessage: 'privacy',
      skillCatalog: catalog,
      region: 'EU',
    });
    expect(eu.create).toHaveBeenCalledTimes(2);
    expect(unpinned.create).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledWith('EU');
  });
  it('missing regional routing configuration degrades without calling default clients', async () => {
    const unpinned = client();
    const router = new ToolRouterService(unpinned.client, () => undefined);
    expect(
      (
        await router.determineSkills({
          messages: [],
          currentMessage: 'privacy',
          skillCatalog: catalog,
          region: 'EU',
        })
      ).degraded,
    ).toBe(true);
    expect(
      (
        await router.determineTool({
          messages: [],
          currentMessage: 'privacy',
          region: 'EU',
        })
      ).degraded,
    ).toBe(true);
    expect(unpinned.create).not.toHaveBeenCalled();
  });
  it('embedding uses the corpus region, not the default Azure client', async () => {
    const create = vi.fn(async () => ({
      data: [{ index: 0, embedding: Array(1536).fill(0) }],
    }));
    regionClients.mockReturnValue({
      azureOpenAIClient: { embeddings: { create } },
    });
    await embedSkillTexts(['policy'], 'embedding');
    expect(regionClients).toHaveBeenCalledWith(env.SKILLS_DATA_REGION);
    expect(create).toHaveBeenCalledOnce();
    regionClients.mockReturnValue({});
    await expect(embedSkillTexts(['policy'], 'embedding')).rejects.toThrow(
      /endpoint/,
    );
  });
  it('EU queries refuse a US corpus and legacy vector records require reindexing', async () => {
    expect(() => assertSkillDataRegion('US', 'EU')).toThrow();
    await expect(
      searchSkillChunks(
        'query',
        'gdpr',
        [
          {
            fileId: '11111111-1111-1111-1111-111111111111',
            filename: 'policy',
            sizeBytes: 1,
            indexStatus: 'indexed',
            nextChunk: 1,
            embeddingDeployment: 'embedding',
          },
        ],
        undefined,
        'EU',
      ),
    ).rejects.toThrow(/reindex/);
  });
  it('Search cannot fall back to the unlabelled general endpoint', () => {
    const original = {
      endpoint: env.SKILLS_SEARCH_ENDPOINT,
      eu: env.SKILLS_SEARCH_ENDPOINT_EU,
      us: env.SKILLS_SEARCH_ENDPOINT_US,
    };
    env.SKILLS_SEARCH_ENDPOINT = undefined;
    env.SKILLS_SEARCH_ENDPOINT_EU = undefined;
    env.SKILLS_SEARCH_ENDPOINT_US = undefined;
    try {
      expect(() => skillSearchEndpoint()).toThrow(/residency fallback/);
    } finally {
      env.SKILLS_SEARCH_ENDPOINT = original.endpoint;
      env.SKILLS_SEARCH_ENDPOINT_EU = original.eu;
      env.SKILLS_SEARCH_ENDPOINT_US = original.us;
    }
  });
});
