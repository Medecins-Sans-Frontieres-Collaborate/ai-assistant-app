/**
 * Index-time embedding deployment resolution: env value preferred, then
 * the agent's stamped value, then common fallbacks — each candidate must
 * exist AND return index-dimension vectors. The resolved value is stamped
 * back onto the agent so retrieval always embeds with what the index used.
 */
import type { M365Agent } from '@/lib/services/agentAccess/types';
import {
  __clearEmbeddingProbeCacheForTests,
  resolveEmbeddingDeployment,
} from '@/lib/services/m365/agentIndexService';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const envMock = vi.hoisted(() => ({
  env: { OPENAI_EMBEDDING_DEPLOYMENT: 'env-embedding' } as Record<
    string,
    string | undefined
  >,
}));
vi.mock('@/config/environment', () => envMock);

const embeddingsCreate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({
      getAzureOpenAIClient: () => ({
        embeddings: { create: embeddingsCreate },
      }),
    }),
  },
}));

function makeAgent(embeddingModelId: string | null): M365Agent {
  return {
    version: 1,
    id: 'm365-abcdefabcdef',
    name: 'Agent',
    description: '',
    systemPrompt: '',
    chatModelId: null,
    embeddingModelId,
    ragConfig: { topK: 10 },
    sources: [],
    createdBy: 'a@x.org',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedBy: 'a@x.org',
    updatedAt: '2026-08-04T00:00:00.000Z',
  } as unknown as M365Agent;
}

/** Deployments in `working` succeed with 1536-dim vectors; others 404. */
function stubDeployments(working: string[], dims = 1536) {
  embeddingsCreate.mockImplementation(({ model }: { model: string }) => {
    if (!working.includes(model)) {
      return Promise.reject(
        new Error('404 The API deployment for this resource does not exist.'),
      );
    }
    return Promise.resolve({
      data: [{ embedding: new Array(dims).fill(0) }],
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearEmbeddingProbeCacheForTests();
  envMock.env = { OPENAI_EMBEDDING_DEPLOYMENT: 'env-embedding' };
});

describe('resolveEmbeddingDeployment', () => {
  it('prefers the env deployment even over a working stamped value', async () => {
    stubDeployments(['env-embedding', 'stamped-embedding']);
    await expect(
      resolveEmbeddingDeployment(makeAgent('stamped-embedding')),
    ).resolves.toBe('env-embedding');
  });

  it('falls back to the stamped value when the env deployment is missing', async () => {
    stubDeployments(['stamped-embedding']);
    await expect(
      resolveEmbeddingDeployment(makeAgent('stamped-embedding')),
    ).resolves.toBe('stamped-embedding');
  });

  it('falls back to common deployment names when both are missing', async () => {
    stubDeployments(['text-embedding-3-small']);
    await expect(
      resolveEmbeddingDeployment(makeAgent('stamped-embedding')),
    ).resolves.toBe('text-embedding-3-small');
  });

  it('rejects deployments with the wrong dimensionality', async () => {
    // env deployment "works" but returns 3072-dim vectors — using it would
    // corrupt the 1536-dim index, so it must be skipped.
    embeddingsCreate.mockImplementation(({ model }: { model: string }) => {
      if (model === 'env-embedding') {
        return Promise.resolve({
          data: [{ embedding: new Array(3072).fill(0) }],
        });
      }
      if (model === 'text-embedding') {
        return Promise.resolve({
          data: [{ embedding: new Array(1536).fill(0) }],
        });
      }
      return Promise.reject(new Error('404'));
    });
    await expect(resolveEmbeddingDeployment(makeAgent(null))).resolves.toBe(
      'text-embedding',
    );
  });

  it('throws an actionable error when nothing resolves', async () => {
    stubDeployments([]);
    await expect(
      resolveEmbeddingDeployment(makeAgent('stamped-embedding')),
    ).rejects.toThrow(/No usable embedding deployment.*env-embedding/s);
  });

  it('caches successful probes per process', async () => {
    stubDeployments(['env-embedding']);
    await resolveEmbeddingDeployment(makeAgent(null));
    await resolveEmbeddingDeployment(makeAgent(null));
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
  });
});
