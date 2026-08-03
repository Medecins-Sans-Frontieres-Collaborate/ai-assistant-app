/**
 * The org-agent index validation proves the whole RAGService retrieval
 * contract — fields, integrated vectorizer, semantic configuration, a live
 * probe query — not merely that the index exists.
 */
import {
  ragContractProblems,
  validateOrgAgentIndex,
} from '@/lib/services/orgAgents/orgAgentSearchValidation';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({
  env: { SEARCH_ENDPOINT: 'https://search.example.net' },
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken() {
      return Promise.resolve({ token: 'tok' });
    }
  },
}));

/** A definition that satisfies the full retrieval contract. */
function goodDefinition() {
  return {
    fields: [
      { name: 'chunk', type: 'Edm.String', searchable: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'date', type: 'Edm.DateTimeOffset' },
      { name: 'url', type: 'Edm.String' },
      { name: 'chunk_id', type: 'Edm.String' },
      {
        name: 'text_vector',
        type: 'Collection(Edm.Single)',
        vectorSearchProfile: 'profile-1',
      },
    ],
    semantic: {
      configurations: [{ name: 'news-semantic-configuration' }],
    },
    vectorSearch: {
      profiles: [{ name: 'profile-1', vectorizer: 'vec-1' }],
      vectorizers: [{ name: 'vec-1' }],
    },
  };
}

describe('ragContractProblems', () => {
  it('accepts a contract-satisfying definition', () => {
    expect(ragContractProblems(goodDefinition(), 'news', '')).toEqual([]);
  });

  it('flags missing select fields and non-retrievable fields', () => {
    const definition = goodDefinition();
    definition.fields = definition.fields.filter((f) => f.name !== 'url');
    (definition.fields[0] as { retrievable?: boolean }).retrievable = false;
    const problems = ragContractProblems(definition, 'news', '');
    expect(problems.join(';')).toContain("missing field 'url'");
    expect(problems.join(';')).toContain("'chunk' is not retrievable");
  });

  it('flags a vector field without an integrated vectorizer', () => {
    const definition = goodDefinition();
    definition.vectorSearch.profiles = [{ name: 'profile-1' } as never];
    const problems = ragContractProblems(definition, 'news', '');
    expect(problems.join(';')).toContain('no integrated vectorizer');
  });

  it('derives the default semantic configuration name from the index', () => {
    // Config is named news-semantic-configuration → validating under a
    // different index name must fail, an explicit matching name must pass.
    expect(
      ragContractProblems(goodDefinition(), 'other-index', '').join(';'),
    ).toContain("missing semantic configuration 'other-index-semantic");
    expect(
      ragContractProblems(
        goodDefinition(),
        'other-index',
        'news-semantic-configuration',
      ),
    ).toEqual([]);
  });
});

describe('validateOrgAgentIndex', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails when the index does not exist', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const result = await validateOrgAgentIndex('missing', '');
    expect(result.status).toBe('failed');
    expect(result.error).toContain("'missing' does not exist");
  });

  it('passes definition + probe and captures the document count', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/docs/search')) {
        return Promise.resolve(
          new Response(JSON.stringify({ value: [] }), { status: 200 }),
        );
      }
      if (url.includes('/docs/$count')) {
        return Promise.resolve(new Response('1234', { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(goodDefinition()), { status: 200 }),
      );
    });
    const result = await validateOrgAgentIndex('news', '');
    expect(result).toMatchObject({ status: 'ok', documentCount: 1234 });
  });

  it('fails when the probe query fails even though the definition passes', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/docs/search')) {
        // e.g. the vectorizer's own credential is broken — only a live
        // query catches this.
        return Promise.resolve(
          new Response('vectorizer down', { status: 400 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(goodDefinition()), { status: 200 }),
      );
    });
    const result = await validateOrgAgentIndex('news', '');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Probe query');
  });

  it('fails with the contract problems when the definition is short', async () => {
    const definition = goodDefinition();
    definition.fields = definition.fields.filter(
      (f) => f.name !== 'text_vector',
    );
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(definition), { status: 200 }),
    );
    const result = await validateOrgAgentIndex('news', '');
    expect(result.status).toBe('failed');
    expect(result.error).toContain("missing vector field 'text_vector'");
  });
});
