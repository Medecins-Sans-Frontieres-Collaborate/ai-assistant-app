/** Shared Azure AI Search index for skill documents; all queries are skill/file scoped. */
import { ServiceContainer } from '@/lib/services/ServiceContainer';

import type { UserRegion } from '@/lib/utils/shared/region';

import { assertSkillDataRegion } from './skillRegion';
import { SKILL_LIMITS, SkillDocument, SkillIdSchema } from './types';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import {
  SearchClient,
  SearchIndex,
  SearchIndexClient,
} from '@azure/search-documents';

const DIMENSIONS = 1536;
export interface SkillSearchChunk {
  chunk_id: string;
  skill_id: string;
  file_id: string;
  chunk: string;
  locator: string;
  text_vector: number[];
}
let ensured: Promise<unknown> | undefined;

export function skillSearchEndpoint(): string {
  const value =
    (env.SKILLS_DATA_REGION === 'EU'
      ? env.SKILLS_SEARCH_ENDPOINT_EU
      : env.SKILLS_SEARCH_ENDPOINT_US) ?? env.SKILLS_SEARCH_ENDPOINT;
  if (!value)
    throw new Error(
      `Configure SKILLS_SEARCH_ENDPOINT_${env.SKILLS_DATA_REGION} (or a dedicated SKILLS_SEARCH_ENDPOINT declared in SKILLS_DATA_REGION). The general Search endpoint is not a residency fallback.`,
    );
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      'Skill Search endpoints must be HTTPS base URLs without embedded credentials or query strings',
    );
  return value;
}
function searchClient(): SearchClient<SkillSearchChunk> {
  return new SearchClient<SkillSearchChunk>(
    skillSearchEndpoint(),
    env.SKILLS_SEARCH_INDEX,
    new DefaultAzureCredential(),
  );
}

/** Index definition follows the app's M365 hybrid-search layout. */
export function skillIndexDefinition(): SearchIndex {
  return {
    name: env.SKILLS_SEARCH_INDEX,
    fields: [
      { name: 'chunk_id', type: 'Edm.String', key: true, filterable: true },
      { name: 'skill_id', type: 'Edm.String', filterable: true },
      { name: 'file_id', type: 'Edm.String', filterable: true },
      { name: 'chunk', type: 'Edm.String', searchable: true },
      { name: 'locator', type: 'Edm.String' },
      {
        name: 'text_vector',
        type: 'Collection(Edm.Single)',
        searchable: true,
        vectorSearchDimensions: DIMENSIONS,
        vectorSearchProfileName: 'skills-profile',
      },
    ],
    vectorSearch: {
      algorithms: [
        { name: 'skills-hnsw', kind: 'hnsw', parameters: { metric: 'cosine' } },
      ],
      profiles: [
        { name: 'skills-profile', algorithmConfigurationName: 'skills-hnsw' },
      ],
    },
    semanticSearch: {
      configurations: [
        {
          name: 'skills-semantic',
          prioritizedFields: { contentFields: [{ name: 'chunk' }] },
        },
      ],
    },
  };
}

/** Provision on indexing, never on chat reads. Retry after provisioning failure. */
export async function ensureSkillIndex(signal?: AbortSignal): Promise<void> {
  ensured ??= new SearchIndexClient(
    skillSearchEndpoint(),
    new DefaultAzureCredential(),
  )
    .createOrUpdateIndex(skillIndexDefinition(), { abortSignal: signal })
    .catch((error) => {
      ensured = undefined;
      throw error;
    });
  await ensured;
}

/** Embeds one bounded batch using the deployment stamped on the document. */
export async function embedSkillTexts(
  texts: string[],
  deployment: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  const client = ServiceContainer.getInstance().getChatClientsForRegion(
    env.SKILLS_DATA_REGION,
  ).azureOpenAIClient;
  if (!client)
    throw new Error(
      `No ${env.SKILLS_DATA_REGION} embedding endpoint configured; default clients are not permitted for skill documents`,
    );
  const result = await client.embeddings.create(
    { model: deployment, input: texts },
    { timeout: 20_000, maxRetries: 0, signal },
  );
  const vectors = [...result.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (
    vectors.length !== texts.length ||
    vectors.some((v) => v.length !== DIMENSIONS)
  )
    throw new Error(
      `Embedding deployment ${deployment} must return ${DIMENSIONS}-dimension vectors`,
    );
  return vectors;
}

/** Upload errors can be per-document even when the HTTP request succeeds. */
export async function uploadSkillChunks(
  chunks: SkillSearchChunk[],
  signal?: AbortSignal,
): Promise<void> {
  const result = await searchClient().mergeOrUploadDocuments(chunks, {
    abortSignal: signal,
  });
  if (result.results.some((item) => !item.succeeded))
    throw new Error('Search rejected one or more skill chunks; retry indexing');
}

/** OData filter for only the manifest's current ready documents. */
export function skillSearchFilter(
  skillId: string,
  documents: SkillDocument[],
): string | null {
  SkillIdSchema.parse(skillId);
  const ids = documents
    .filter(
      (doc) =>
        doc.indexStatus === 'indexed' && /^[a-f0-9-]{36}$/.test(doc.fileId),
    )
    .map((doc) => doc.fileId);
  return ids.length
    ? `skill_id eq '${skillId}' and search.in(file_id, '${ids.join(',')}', ',')`
    : null;
}

/** Hybrid lexical/vector retrieval with semantic reranking and strict file scope. */
export async function searchSkillChunks(
  query: string,
  skillId: string,
  documents: SkillDocument[],
  signal?: AbortSignal,
  requestRegion?: UserRegion,
): Promise<Omit<SkillSearchChunk, 'text_vector'>[]> {
  assertSkillDataRegion(env.SKILLS_DATA_REGION, requestRegion);
  const found: Omit<SkillSearchChunk, 'text_vector'>[] = [];
  const groups = new Map<string, SkillDocument[]>();
  for (const doc of documents.filter((doc) => doc.indexStatus === 'indexed')) {
    if (doc.embeddingRegion !== env.SKILLS_DATA_REGION)
      throw new Error(
        'Skill documents require reindexing for the configured data region before retrieval',
      );
    if (!doc.embeddingDeployment) continue;
    groups.set(doc.embeddingDeployment, [
      ...(groups.get(doc.embeddingDeployment) ?? []),
      doc,
    ]);
  }
  for (const [deployment, docs] of groups) {
    const filter = skillSearchFilter(skillId, docs);
    if (!filter) continue;
    const [vector] = await embedSkillTexts(
      [query.slice(0, 6000)],
      deployment,
      signal,
    );
    const result = await searchClient().search(query.slice(0, 6000), {
      filter,
      top: SKILL_LIMITS.referenceChunksPerSkill,
      select: ['chunk_id', 'skill_id', 'file_id', 'chunk', 'locator'],
      queryType: 'semantic',
      semanticSearchOptions: { configurationName: 'skills-semantic' },
      vectorSearchOptions: {
        filterMode: 'preFilter',
        queries: [
          {
            kind: 'vector',
            vector,
            fields: ['text_vector'],
            kNearestNeighborsCount: 50,
          },
        ],
      },
      abortSignal: signal,
    });
    for await (const entry of result.results) {
      // Defense in depth against stale/misconfigured search responses.
      if (
        entry.document.skill_id === skillId &&
        docs.some((doc) => doc.fileId === entry.document.file_id)
      )
        found.push(entry.document);
    }
  }
  return found.slice(0, SKILL_LIMITS.referenceChunksPerSkill);
}

/** Best-effort deletion; manifest filtering already removes access synchronously. */
export async function deleteSkillChunks(
  fileId: string,
  chunkCount: number,
  location?: { endpoint: string; index: string },
  signal?: AbortSignal,
): Promise<void> {
  if (!chunkCount) return;
  const ids = Array.from(
    { length: Math.min(chunkCount, 300) },
    (_, i) => `${fileId}_${i}`,
  );
  const client = location
    ? new SearchClient<SkillSearchChunk>(
        location.endpoint,
        location.index,
        new DefaultAzureCredential(),
      )
    : searchClient();
  const result = await client.deleteDocuments('chunk_id', ids, {
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (result.results.some((item) => !item.succeeded))
    throw new Error('Some skill chunks could not be deleted');
}
