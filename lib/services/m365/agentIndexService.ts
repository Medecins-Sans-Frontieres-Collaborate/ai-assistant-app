/**
 * Push-model indexing + retrieval for M365 file-backed agents
 * (docs/M365_SECOND_PASS_AGENTS_DESIGN.md).
 *
 * This is the app's first push-model ingestion: unlike the org RAG index
 * (populated out-of-band by an Azure AI Search indexer with integrated
 * vectorization), M365 agent sources are read with the CREATOR'S delegated
 * Graph token at index time, so the app extracts, chunks, embeds, and
 * uploads documents itself. The index deliberately has NO integrated
 * vectorizer — queries are embedded app-side with the same deployment used
 * at ingestion, so the embedding model stays swappable per agent (a change
 * requires re-index).
 *
 * One shared index (`m365-agents` by default) holds every agent's chunks,
 * partitioned by `agent_id` and `source_id` filters. Retrieval is ALWAYS
 * filtered to the sources the requesting user's own token can open (layer-2
 * trim — see agentSourceAccess.ts); there is no unfiltered read path.
 */
import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import type { M365Agent } from '@/lib/services/agentAccess/types';
import { M365Error, graphFetch, graphJson } from '@/lib/services/m365/graphApi';

import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';

/**
 * Documents per agent after folder expansion (env-tunable, default 50).
 * Layer-2 probes batch 20-per-request (agentSourceAccess), so the practical
 * ceiling is the synchronous index route's wall clock, not probe fan-out.
 */
export const MAX_M365_AGENT_DOCUMENTS = env.M365_AGENT_MAX_DOCUMENTS;
/** Per-file byte cap — matches the extraction budget, with headroom. */
export const MAX_M365_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

const GRAPH_SCOPES = ['Files.ReadWrite.All'];
const EMBEDDING_DIMENSIONS = 1536;
const EMBED_BATCH_SIZE = 16;
const CHUNK_CHARS = 3000;
const CHUNK_OVERLAP = 300;
const MAX_CHUNKS_PER_DOCUMENT = 300;

export interface M365AgentIndexDoc {
  chunk_id: string;
  agent_id: string;
  source_id: string;
  chunk: string;
  title: string;
  url: string;
  date: string;
  text_vector: number[];
}

export function m365AgentsSearchEndpoint(): string {
  const endpoint = env.M365_AGENTS_SEARCH_ENDPOINT || env.SEARCH_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'M365_AGENTS_SEARCH_ENDPOINT (or SEARCH_ENDPOINT) is not configured',
    );
  }
  return endpoint;
}

let cachedSearchClient: SearchClient<M365AgentIndexDoc> | null = null;

function getSearchClient(): SearchClient<M365AgentIndexDoc> {
  if (!cachedSearchClient) {
    cachedSearchClient = new SearchClient<M365AgentIndexDoc>(
      m365AgentsSearchEndpoint(),
      env.M365_AGENTS_SEARCH_INDEX,
      new DefaultAzureCredential(),
    );
  }
  return cachedSearchClient;
}

// ---------------------------------------------------------------------------
// Index provisioning (idempotent createOrUpdate, once per process)
// ---------------------------------------------------------------------------

let indexEnsured: Promise<void> | null = null;

/**
 * Creates or updates the shared index via the raw REST API (the same
 * approach as scripts/search/components/create-index.ts). Schema mirrors
 * the org index's HNSW + semantic setup but has NO vectorizer.
 */
export function ensureM365AgentsIndex(): Promise<void> {
  if (!indexEnsured) {
    indexEnsured = createOrUpdateIndex().catch((error) => {
      indexEnsured = null; // retry on next call
      throw error;
    });
  }
  return indexEnsured;
}

async function createOrUpdateIndex(): Promise<void> {
  const endpoint = m365AgentsSearchEndpoint();
  const indexName = env.M365_AGENTS_SEARCH_INDEX;
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken('https://search.azure.com/.default');

  const definition = {
    name: indexName,
    fields: [
      {
        name: 'chunk_id',
        type: 'Edm.String',
        key: true,
        analyzer: 'keyword',
        searchable: true,
        filterable: true,
        sortable: true,
      },
      { name: 'agent_id', type: 'Edm.String', filterable: true },
      { name: 'source_id', type: 'Edm.String', filterable: true },
      { name: 'chunk', type: 'Edm.String', searchable: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'url', type: 'Edm.String' },
      {
        name: 'date',
        type: 'Edm.DateTimeOffset',
        filterable: true,
        sortable: true,
      },
      {
        name: 'text_vector',
        type: 'Collection(Edm.Single)',
        searchable: true,
        dimensions: EMBEDDING_DIMENSIONS,
        vectorSearchProfile: `${indexName}-profile`,
      },
    ],
    similarity: { '@odata.type': '#Microsoft.Azure.Search.BM25Similarity' },
    semantic: {
      configurations: [
        {
          name: `${indexName}-semantic-configuration`,
          prioritizedFields: {
            titleField: { fieldName: 'title' },
            prioritizedContentFields: [{ fieldName: 'chunk' }],
            prioritizedKeywordsFields: [],
          },
        },
      ],
    },
    vectorSearch: {
      algorithms: [
        {
          name: `${indexName}-algorithm`,
          kind: 'hnsw',
          hnswParameters: {
            metric: 'cosine',
            m: 4,
            efConstruction: 400,
            efSearch: 500,
          },
        },
      ],
      // Deliberately no vectorizer — queries are embedded app-side.
      profiles: [
        { name: `${indexName}-profile`, algorithm: `${indexName}-algorithm` },
      ],
    },
  };

  const response = await fetch(
    `${endpoint}/indexes/${encodeURIComponent(indexName)}?api-version=2025-09-01`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.token}`,
      },
      body: JSON.stringify(definition),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to create/update m365-agents index (${response.status}): ${body.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Chunking + embedding
// ---------------------------------------------------------------------------

/**
 * Overlap-aware character chunker. Prefers to break at a paragraph or
 * sentence boundary near the target size so chunks stay readable.
 */
export function chunkText(
  text: string,
  chunkChars: number = CHUNK_CHARS,
  overlap: number = CHUNK_OVERLAP,
): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= chunkChars) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length && chunks.length < MAX_CHUNKS_PER_DOCUMENT) {
    let end = Math.min(start + chunkChars, cleaned.length);
    if (end < cleaned.length) {
      // Look for a natural boundary in the last 20% of the window.
      const windowStart = start + Math.floor(chunkChars * 0.8);
      const slice = cleaned.slice(windowStart, end);
      const paragraphBreak = slice.lastIndexOf('\n\n');
      const sentenceBreak = slice.lastIndexOf('. ');
      const breakAt = paragraphBreak >= 0 ? paragraphBreak : sentenceBreak;
      if (breakAt >= 0) {
        end = windowStart + breakAt + (paragraphBreak >= 0 ? 2 : 1);
      }
    }
    chunks.push(cleaned.slice(start, end).trim());
    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

/** Embeds texts with the agent's deployment (batched). */
export async function embedTexts(
  texts: string[],
  deployment: string,
): Promise<number[][]> {
  const client = ServiceContainer.getInstance().getAzureOpenAIClient();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: deployment,
      input: batch,
    });
    for (const item of response.data) {
      vectors.push(item.embedding);
    }
  }
  return vectors;
}

export function embeddingDeploymentFor(agent: M365Agent): string {
  return agent.embeddingModelId || env.OPENAI_EMBEDDING_DEPLOYMENT;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

interface GraphItemMeta {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

interface ResolvedDocument {
  sourceId: string;
  driveId: string;
  itemId: string;
  title: string;
  webUrl: string;
  lastModified: string;
}

/**
 * Expands the agent's sources into the concrete document list: files pass
 * through; folders contribute their immediate child files (snapshot — live
 * folder tracking via delta sync is a prod prerequisite, not in v1).
 * Throws when the expansion exceeds MAX_M365_AGENT_DOCUMENTS.
 */
async function resolveDocuments(
  req: NextRequest,
  agent: M365Agent,
): Promise<Map<string, ResolvedDocument[]>> {
  const bySource = new Map<string, ResolvedDocument[]>();
  let total = 0;

  for (const source of agent.sources) {
    const docs: ResolvedDocument[] = [];
    if (source.kind === 'folder') {
      // One page, sized so an over-cap folder is DETECTED (cap+1) rather
      // than silently truncated to the cap.
      const childPage = Math.min(MAX_M365_AGENT_DOCUMENTS + 1, 200);
      const children = await graphJson<{ value?: GraphItemMeta[] }>(
        req,
        GRAPH_SCOPES,
        `/drives/${encodeURIComponent(source.driveId)}/items/${encodeURIComponent(source.itemId)}/children` +
          `?$select=id,name,size,webUrl,lastModifiedDateTime,folder,file&$top=${childPage}`,
      );
      for (const child of children.value ?? []) {
        if (child.folder || !child.id || !child.name) continue;
        docs.push({
          sourceId: source.sourceId,
          driveId: source.driveId,
          itemId: child.id,
          title: child.name,
          webUrl: child.webUrl ?? source.webUrl,
          lastModified: child.lastModifiedDateTime ?? new Date().toISOString(),
        });
      }
    } else {
      docs.push({
        sourceId: source.sourceId,
        driveId: source.driveId,
        itemId: source.itemId,
        title: source.title,
        webUrl: source.webUrl,
        lastModified: new Date().toISOString(),
      });
    }
    total += docs.length;
    if (total > MAX_M365_AGENT_DOCUMENTS) {
      throw new M365Error(
        `Agent expands to more than ${MAX_M365_AGENT_DOCUMENTS} documents — remove sources or narrow folders`,
        'graph_error',
        400,
      );
    }
    bySource.set(source.sourceId, docs);
  }
  return bySource;
}

async function downloadAndExtract(
  req: NextRequest,
  doc: ResolvedDocument,
): Promise<string> {
  const meta = await graphJson<GraphItemMeta>(
    req,
    GRAPH_SCOPES,
    `/drives/${encodeURIComponent(doc.driveId)}/items/${encodeURIComponent(doc.itemId)}` +
      '?$select=name,size,file,lastModifiedDateTime,@microsoft.graph.downloadUrl',
  );
  if ((meta.size ?? 0) > MAX_M365_SOURCE_FILE_BYTES) {
    throw new M365Error(
      `File exceeds the ${Math.round(MAX_M365_SOURCE_FILE_BYTES / (1024 * 1024))}MB indexing limit`,
      'graph_error',
      400,
    );
  }
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const content = downloadUrl
    ? await fetch(downloadUrl)
    : await graphFetch(
        req,
        GRAPH_SCOPES,
        `/drives/${encodeURIComponent(doc.driveId)}/items/${encodeURIComponent(doc.itemId)}/content`,
      );
  if (!content.ok) {
    throw new M365Error('Failed to download file content', 'graph_error', 502);
  }
  const buffer = Buffer.from(await content.arrayBuffer());
  const file = new File([new Uint8Array(buffer)], meta.name ?? doc.title);
  return loadDocument(file);
}

async function deleteSourceDocuments(
  client: SearchClient<M365AgentIndexDoc>,
  agentId: string,
  sourceId?: string,
): Promise<void> {
  const filter = sourceId
    ? `agent_id eq '${agentId}' and source_id eq '${sourceId}'`
    : `agent_id eq '${agentId}'`;
  // Collect keys page by page, then delete. Bounded: ≤10 documents ×
  // ≤300 chunks per agent.
  for (;;) {
    const results = await client.search('*', {
      filter,
      select: ['chunk_id'],
      top: 1000,
    });
    const ids: string[] = [];
    for await (const result of results.results) {
      ids.push(result.document.chunk_id);
    }
    if (ids.length === 0) return;
    await client.deleteDocuments('chunk_id', ids);
    if (ids.length < 1000) return;
  }
}

/** Removes the chunks of specific sources (used when an edit drops sources). */
export async function purgeSourcesFromIndex(
  agentId: string,
  sourceIds: string[],
): Promise<void> {
  try {
    await ensureM365AgentsIndex();
    const client = getSearchClient();
    for (const sourceId of sourceIds) {
      await deleteSourceDocuments(client, agentId, sourceId);
    }
  } catch (error) {
    console.error(
      `[m365-agents] source purge failed for ${sanitizeForLog(agentId)}: ${sanitizeForLog(error)}`,
    );
  }
}

/** Removes every indexed chunk belonging to an agent (used on delete). */
export async function purgeAgentFromIndex(agentId: string): Promise<void> {
  try {
    await ensureM365AgentsIndex();
    await deleteSourceDocuments(getSearchClient(), agentId);
  } catch (error) {
    // Best-effort: orphaned chunks are unreachable anyway (retrieval always
    // filters by an existing agent's id), but log for cleanup.
    console.error(
      `[m365-agents] index purge failed for ${sanitizeForLog(agentId)}: ${sanitizeForLog(error)}`,
    );
  }
}

export interface SourceIndexOutcome {
  sourceId: string;
  status: 'indexed' | 'error' | 'missing';
  indexedChunks: number;
  error?: string;
}

/**
 * Sources processed concurrently per index run. Each source is itself
 * sequential (download → extract → embed → upload); 3 in flight keeps a
 * 50-document run inside the route's 300s budget without hammering Graph
 * or the extraction toolchain (pandoc/LibreOffice are process-per-file).
 */
const SOURCE_INDEX_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Indexes every source of an agent using the CALLING USER'S Graph token
 * (creation/refresh runs only while someone with file access is present —
 * there is no offline token access, by design). Returns per-source
 * outcomes in source order; the caller persists them onto the agent record.
 */
export async function indexAgentSources(
  req: NextRequest,
  agent: M365Agent,
): Promise<SourceIndexOutcome[]> {
  await ensureM365AgentsIndex();
  const client = getSearchClient();
  const deployment = embeddingDeploymentFor(agent);
  const documentsBySource = await resolveDocuments(req, agent);

  const indexOneSource = async (
    source: M365Agent['sources'][number],
  ): Promise<SourceIndexOutcome> => {
    const docs = documentsBySource.get(source.sourceId) ?? [];
    try {
      const uploadDocs: M365AgentIndexDoc[] = [];
      for (const doc of docs) {
        const text = await downloadAndExtract(req, doc);
        const chunks = chunkText(text);
        const vectors = await embedTexts(chunks, deployment);
        chunks.forEach((chunk, index) => {
          uploadDocs.push({
            chunk_id: `${agent.id}_${doc.sourceId}_${doc.itemId.replace(/[^A-Za-z0-9_=-]/g, '')}_${index}`,
            agent_id: agent.id,
            source_id: doc.sourceId,
            chunk,
            title: doc.title,
            url: doc.webUrl,
            date: doc.lastModified,
            text_vector: vectors[index],
          });
        });
      }

      // Replace-by-source: old chunks out, new chunks in.
      await deleteSourceDocuments(client, agent.id, source.sourceId);
      if (uploadDocs.length > 0) {
        await client.mergeOrUploadDocuments(uploadDocs);
      }
      return {
        sourceId: source.sourceId,
        status: 'indexed',
        indexedChunks: uploadDocs.length,
      };
    } catch (error) {
      const missing =
        error instanceof M365Error &&
        (error.kind === 'not_found' || error.kind === 'forbidden');
      console.error(
        `[m365-agents] indexing failed for agent ${sanitizeForLog(agent.id)} source ${sanitizeForLog(source.sourceId)}: ${sanitizeForLog(error)}`,
      );
      return {
        sourceId: source.sourceId,
        status: missing ? 'missing' : 'error',
        indexedChunks: 0,
        error:
          error instanceof Error
            ? error.message.slice(0, 300)
            : 'Unknown error',
      };
    }
  };

  return mapWithConcurrency(
    agent.sources,
    SOURCE_INDEX_CONCURRENCY,
    indexOneSource,
  );
}

// ---------------------------------------------------------------------------
// Retrieval (layer-2-trimmed hybrid search)
// ---------------------------------------------------------------------------

export interface M365AgentSearchDoc {
  chunk: string;
  chunk_id: string;
  title: string;
  date: string;
  url: string;
}

/**
 * Hybrid vector+semantic retrieval over the agent's chunks, HARD-FILTERED
 * to the sources the requesting user's own token can open. Never call this
 * with an unverified `accessibleSourceIds` — the filter IS the layer-2
 * enforcement.
 */
export async function searchM365Agent(
  query: string,
  agent: M365Agent,
  accessibleSourceIds: string[],
): Promise<M365AgentSearchDoc[]> {
  if (accessibleSourceIds.length === 0) return [];
  await ensureM365AgentsIndex();
  const client = getSearchClient();
  const [vector] = await embedTexts([query], embeddingDeploymentFor(agent));
  const topK = agent.ragConfig?.topK ?? 10;
  const fetchCount = Math.min(topK * 2, 20);
  const indexName = env.M365_AGENTS_SEARCH_INDEX;

  const sourceList = accessibleSourceIds
    .map((id) => id.replace(/[^A-Za-z0-9_-]/g, ''))
    .join(',');
  const filter = `agent_id eq '${agent.id}' and search.in(source_id, '${sourceList}', ',')`;

  const results = await client.search(query, {
    filter,
    select: ['chunk', 'chunk_id', 'title', 'date', 'url'],
    top: fetchCount,
    queryType: 'semantic',
    semanticSearchOptions: {
      configurationName: `${indexName}-semantic-configuration`,
    },
    vectorSearchOptions: {
      queries: [
        {
          kind: 'vector',
          vector,
          fields: ['text_vector'],
          kNearestNeighborsCount: fetchCount,
        },
      ],
    },
  });

  const docs: M365AgentSearchDoc[] = [];
  const seen = new Set<string>();
  for await (const result of results.results) {
    const doc = result.document;
    if (seen.has(doc.chunk_id)) continue;
    seen.add(doc.chunk_id);
    docs.push({
      chunk: doc.chunk,
      chunk_id: doc.chunk_id,
      title: doc.title,
      date: doc.date,
      url: doc.url,
    });
    if (docs.length >= topK) break;
  }
  return docs;
}
