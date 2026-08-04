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
 * partitioned by `agent_id`, `source_id`, and `item_id` filters. Retrieval
 * is ALWAYS filtered to what the requesting user's own token can open
 * (layer-2 trim — see agentSourceAccess.ts): by source for file sources,
 * per child file for folder sources. There is no unfiltered read path.
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
  /** Sanitized Graph drive-item id — the per-file trim unit for folder sources. */
  item_id: string;
  chunk: string;
  title: string;
  url: string;
  date: string;
  /** Human-readable position in the source document ("p. 12"), when known. */
  locator: string;
  text_vector: number[];
}

/**
 * Normalizes a Graph id for use in index keys and search.in filter lists.
 * Applied identically at ingestion and query time so values always compare
 * equal; strips the list delimiter (',') and quote characters as a side
 * effect, making the sanitized value filter-safe.
 */
export function sanitizeGraphId(id: string): string {
  return id.replace(/[^A-Za-z0-9_=-]/g, '');
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
      { name: 'item_id', type: 'Edm.String', filterable: true },
      { name: 'locator', type: 'Edm.String' },
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

interface ChunkSpan {
  start: number;
  end: number;
}

/**
 * Core overlap-aware character chunker over an ALREADY-normalized string.
 * Returns spans (offsets into `text`) so callers can attribute chunks to
 * document locations; prefers to break at a paragraph or sentence boundary
 * near the target size so chunks stay readable.
 */
function chunkSpans(
  text: string,
  chunkChars: number,
  overlap: number,
): ChunkSpan[] {
  if (!text.trim()) return [];
  if (text.length <= chunkChars) return [{ start: 0, end: text.length }];

  const spans: ChunkSpan[] = [];
  let start = 0;
  while (start < text.length && spans.length < MAX_CHUNKS_PER_DOCUMENT) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      // Look for a natural boundary in the last 20% of the window.
      const windowStart = start + Math.floor(chunkChars * 0.8);
      const slice = text.slice(windowStart, end);
      const paragraphBreak = slice.lastIndexOf('\n\n');
      const sentenceBreak = slice.lastIndexOf('. ');
      const breakAt = paragraphBreak >= 0 ? paragraphBreak : sentenceBreak;
      if (breakAt >= 0) {
        end = windowStart + breakAt + (paragraphBreak >= 0 ? 2 : 1);
      }
    }
    spans.push({ start, end });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return spans;
}

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
  return chunkSpans(cleaned, chunkChars, overlap)
    .map((span) => cleaned.slice(span.start, span.end).trim())
    .filter((c) => c.length > 0);
}

export interface LocatedChunk {
  chunk: string;
  /** Human-readable position in the source, e.g. "p. 12" / "pp. 12–13". */
  locator?: string;
}

/** A page's starting offset within the marker-stripped text. */
interface PageStart {
  offset: number;
  page: number;
}

/**
 * Strips page markers from extracted text while recording where each page
 * begins. Two marker dialects, matching the two PDF extractors upstream
 * (fileHandling.ts): pdfjs joins pages with "--- Page N ---" lines;
 * pdftotext separates them with form feeds. Text without markers (DOCX and
 * friends are flowing formats) yields no page map — chunks simply carry no
 * locator.
 */
function stripPageMarkers(text: string): {
  stripped: string;
  pageStarts: PageStart[];
} {
  const pdfjsMarker = /^--- Page (\d+) ---$\n?/gm;
  if (pdfjsMarker.test(text)) {
    const pageStarts: PageStart[] = [];
    let stripped = '';
    let lastIndex = 0;
    pdfjsMarker.lastIndex = 0;
    for (const match of text.matchAll(pdfjsMarker)) {
      stripped += text.slice(lastIndex, match.index);
      pageStarts.push({
        offset: stripped.length,
        page: Number(match[1]),
      });
      lastIndex = match.index + match[0].length;
    }
    stripped += text.slice(lastIndex);
    return { stripped, pageStarts };
  }

  if (text.includes('\f')) {
    const parts = text.split('\f');
    const pageStarts: PageStart[] = [];
    let stripped = '';
    parts.forEach((part, index) => {
      pageStarts.push({ offset: stripped.length, page: index + 1 });
      stripped += part;
      // Keep a paragraph boundary where the page break was, so the
      // chunker still prefers breaking there.
      if (index < parts.length - 1) stripped += '\n\n';
    });
    return { stripped, pageStarts };
  }

  return { stripped: text, pageStarts: [] };
}

function locatorForSpan(
  span: ChunkSpan,
  pageStarts: PageStart[],
): string | undefined {
  if (pageStarts.length < 2) return undefined;
  let first: number | undefined;
  let last: number | undefined;
  for (let i = 0; i < pageStarts.length; i++) {
    const pageStart = pageStarts[i].offset;
    const pageEnd =
      i + 1 < pageStarts.length ? pageStarts[i + 1].offset : Infinity;
    if (pageStart < span.end && pageEnd > span.start) {
      first = first ?? pageStarts[i].page;
      last = pageStarts[i].page;
    }
  }
  if (first === undefined || last === undefined) return undefined;
  return first === last ? `p. ${first}` : `pp. ${first}–${last}`;
}

/**
 * Chunks an extracted document, attributing each chunk to the page range
 * it came from when the extraction preserved page structure. NOTE: no
 * global trim — offsets must stay aligned with the page map; individual
 * chunks are trimmed on slice.
 */
export function chunkDocument(
  text: string,
  chunkChars: number = CHUNK_CHARS,
  overlap: number = CHUNK_OVERLAP,
): LocatedChunk[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const { stripped, pageStarts } = stripPageMarkers(normalized);
  return chunkSpans(stripped, chunkChars, overlap)
    .map((span) => ({
      chunk: stripped.slice(span.start, span.end).trim(),
      locator: locatorForSpan(span, pageStarts),
    }))
    .filter((c) => c.chunk.length > 0);
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
    let response;
    try {
      response = await client.embeddings.create({
        model: deployment,
        input: batch,
      });
    } catch (error) {
      // A bare Azure 404 here reads as a mystery; name the deployment so
      // the per-source error (and admin UI) says what to fix. The agent's
      // embeddingModelId is stamped from OPENAI_EMBEDDING_DEPLOYMENT at
      // creation, so a stale env value bakes into the record.
      if (
        error instanceof Error &&
        error.message.includes('deployment for this resource does not exist')
      ) {
        throw new Error(
          `Embedding deployment '${deployment}' does not exist on this account. ` +
            `Fix OPENAI_EMBEDDING_DEPLOYMENT (and recreate the agent — the value is stamped at creation).`,
        );
      }
      throw error;
    }
    for (const item of response.data) {
      vectors.push(item.embedding);
    }
  }
  return vectors;
}

export function embeddingDeploymentFor(agent: M365Agent): string {
  return agent.embeddingModelId || env.OPENAI_EMBEDDING_DEPLOYMENT;
}

/**
 * Common Azure OpenAI embedding deployment names, probed as a last resort
 * when neither the env-configured nor the agent's stamped deployment
 * exists on this account (environments name their deployments
 * inconsistently — e.g. live EU 'text-embedding' vs dev
 * 'text-embedding-3-small').
 */
const FALLBACK_EMBEDDING_DEPLOYMENTS = [
  'text-embedding',
  'text-embedding-3-small',
  'text-embedding-ada-002',
];

/** Successful probes cache per-process; failures re-probe (cheap, rare). */
const embeddingProbeSuccesses = new Set<string>();

/**
 * A deployment is usable only if it exists AND returns vectors matching
 * the index schema's dimensions — text-embedding-3-large at its native
 * 3072 must be rejected here, not silently corrupt the index.
 */
async function probeEmbeddingDeployment(deployment: string): Promise<boolean> {
  if (embeddingProbeSuccesses.has(deployment)) return true;
  try {
    const client = ServiceContainer.getInstance().getAzureOpenAIClient();
    const response = await client.embeddings.create({
      model: deployment,
      input: ['ping'],
    });
    const usable = response.data[0]?.embedding?.length === EMBEDDING_DIMENSIONS;
    if (usable) embeddingProbeSuccesses.add(deployment);
    return usable;
  } catch {
    return false;
  }
}

/**
 * Index-time embedding deployment resolution. The env value is preferred —
 * a (re-)index run adopts it whenever it works, healing records stamped
 * with a name this environment doesn't have — then the agent's stamped
 * value, then common fallbacks. The caller MUST persist the resolved value
 * onto the agent record (embeddingModelId): queries embed with the stamped
 * deployment, and mixing deployments between ingestion and retrieval
 * silently breaks vector similarity.
 */
export async function resolveEmbeddingDeployment(
  agent: M365Agent,
): Promise<string> {
  const candidates = [
    ...new Set(
      [
        env.OPENAI_EMBEDDING_DEPLOYMENT,
        agent.embeddingModelId,
        ...FALLBACK_EMBEDDING_DEPLOYMENTS,
      ].filter((c): c is string => !!c),
    ),
  ];
  for (const candidate of candidates) {
    if (await probeEmbeddingDeployment(candidate)) {
      if (candidate !== candidates[0]) {
        console.warn(
          `[m365-agents] embedding deployment fallback: using '${sanitizeForLog(candidate)}' (preferred '${sanitizeForLog(candidates[0])}' unavailable)`,
        );
      }
      return candidate;
    }
  }
  throw new Error(
    `No usable embedding deployment on this account (need ${EMBEDDING_DIMENSIONS}-dim output); tried: ${candidates.join(', ')}. ` +
      'Set OPENAI_EMBEDDING_DEPLOYMENT to a deployed embedding model.',
  );
}

/** Test hook. */
export function __clearEmbeddingProbeCacheForTests(): void {
  embeddingProbeSuccesses.clear();
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

/**
 * OData string-literal escaping (single quotes double). Ids are
 * server-generated today, but the stored schema tolerates arbitrary
 * strings — never let a quote widen a filter on the SHARED index.
 */
function odataEscape(value: string): string {
  return value.replace(/'/g, "''");
}

async function deleteSourceDocuments(
  client: SearchClient<M365AgentIndexDoc>,
  agentId: string,
  sourceId?: string,
): Promise<void> {
  const filter = sourceId
    ? `agent_id eq '${odataEscape(agentId)}' and source_id eq '${odataEscape(sourceId)}'`
    : `agent_id eq '${odataEscape(agentId)}'`;
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

export interface AgentIndexRun {
  outcomes: SourceIndexOutcome[];
  /**
   * The deployment every chunk in this run was embedded with. The caller
   * MUST stamp it onto the agent record (embeddingModelId) — retrieval
   * embeds queries with the stamped value, and it has to match the index.
   */
  embeddingDeployment: string;
}

/**
 * Indexes every source of an agent using the CALLING USER'S Graph token
 * (creation/refresh runs only while someone with file access is present —
 * there is no offline token access, by design). Returns per-source
 * outcomes in source order; the caller persists them (and the resolved
 * embedding deployment) onto the agent record.
 */
export async function indexAgentSources(
  req: NextRequest,
  agent: M365Agent,
): Promise<AgentIndexRun> {
  await ensureM365AgentsIndex();
  const client = getSearchClient();
  const deployment = await resolveEmbeddingDeployment(agent);
  const documentsBySource = await resolveDocuments(req, agent);

  const indexOneSource = async (
    source: M365Agent['sources'][number],
  ): Promise<SourceIndexOutcome> => {
    const docs = documentsBySource.get(source.sourceId) ?? [];
    try {
      const uploadDocs: M365AgentIndexDoc[] = [];
      for (const doc of docs) {
        const text = await downloadAndExtract(req, doc);
        const chunks = chunkDocument(text);
        if (chunks.length === 0) {
          // Surfaced to admins via the zero-chunk warning in the agents
          // list; logged here with the item for diagnosis.
          console.warn(
            `[m365-agents] extraction yielded no text for agent ${sanitizeForLog(agent.id)} item ${sanitizeForLog(doc.itemId)} (scanned/image-only file?)`,
          );
        }
        const vectors = await embedTexts(
          chunks.map((c) => c.chunk),
          deployment,
        );
        const itemId = sanitizeGraphId(doc.itemId);
        chunks.forEach((chunk, index) => {
          uploadDocs.push({
            chunk_id: `${agent.id}_${doc.sourceId}_${itemId}_${index}`,
            agent_id: agent.id,
            source_id: doc.sourceId,
            item_id: itemId,
            locator: chunk.locator ?? '',
            chunk: chunk.chunk,
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

  const outcomes = await mapWithConcurrency(
    agent.sources,
    SOURCE_INDEX_CONCURRENCY,
    indexOneSource,
  );
  return { outcomes, embeddingDeployment: deployment };
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
  /** "p. 12" / "pp. 12–13" when the source had page structure; else ''. */
  locator: string;
  /**
   * Verbatim passage from this chunk, chosen by the semantic ranker as
   * most relevant to the query (extractive caption — never generated).
   * Falls back to the chunk's opening sentences.
   */
  quote: string;
}

/**
 * Hybrid vector+semantic retrieval over the agent's chunks, HARD-FILTERED
 * to what the requesting user's own token can open. File-kind sources are
 * trimmed by source_id; folder-kind sources are trimmed PER CHILD FILE via
 * item_id (`accessibleFolderItemIds` from agentSourceAccess) — a
 * folder-level verdict alone would leak item-restricted children. Never
 * call this with unverified access lists — the filter IS the layer-2
 * enforcement.
 */
/**
 * Builds the layer-2 access filter, or null when nothing may be read.
 * Exported for tests — this string IS the enforcement boundary.
 */
export function buildM365AccessFilter(
  agent: M365Agent,
  accessibleSourceIds: string[],
  accessibleFolderItemIds: string[],
): string | null {
  if (accessibleSourceIds.length === 0) return null;

  const kindBySourceId = new Map(
    agent.sources.map((source) => [source.sourceId, source.kind]),
  );
  const fileSourceList = accessibleSourceIds
    .filter((id) => kindBySourceId.get(id) !== 'folder')
    .map((id) => id.replace(/[^A-Za-z0-9_-]/g, ''))
    .join(',');
  const folderItemList = accessibleFolderItemIds
    .map((id) => sanitizeGraphId(id))
    .filter((id) => id.length > 0)
    .join(',');

  const accessClauses: string[] = [];
  if (fileSourceList) {
    accessClauses.push(`search.in(source_id, '${fileSourceList}', ',')`);
  }
  if (folderItemList) {
    accessClauses.push(`search.in(item_id, '${folderItemList}', ',')`);
  }
  // Accessible sources but no matchable clause (e.g. accessible folders
  // whose visible children resolved to none): nothing may be read.
  if (accessClauses.length === 0) return null;

  return `agent_id eq '${odataEscape(agent.id)}' and (${accessClauses.join(' or ')})`;
}

export async function searchM365Agent(
  query: string,
  agent: M365Agent,
  accessibleSourceIds: string[],
  accessibleFolderItemIds: string[] = [],
): Promise<M365AgentSearchDoc[]> {
  const filter = buildM365AccessFilter(
    agent,
    accessibleSourceIds,
    accessibleFolderItemIds,
  );
  if (filter === null) return [];

  await ensureM365AgentsIndex();
  const client = getSearchClient();
  const [vector] = await embedTexts([query], embeddingDeploymentFor(agent));
  const topK = agent.ragConfig?.topK ?? 10;
  const fetchCount = Math.min(topK * 2, 20);
  const indexName = env.M365_AGENTS_SEARCH_INDEX;

  const results = await client.search(query, {
    filter,
    select: ['chunk', 'chunk_id', 'title', 'date', 'url', 'locator'],
    top: fetchCount,
    queryType: 'semantic',
    semanticSearchOptions: {
      configurationName: `${indexName}-semantic-configuration`,
      // Extractive captions feed citation quotes: verbatim passages chosen
      // by the ranker, so the evidence shown to users is never generated.
      captions: { captionType: 'extractive' },
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
    // Captions carry <em> highlight markup in `highlights`; `text` is the
    // clean verbatim passage.
    const caption = result.captions?.[0]?.text?.trim();
    docs.push({
      chunk: doc.chunk,
      chunk_id: doc.chunk_id,
      title: doc.title,
      date: doc.date,
      url: doc.url,
      // Pre-locator chunks have no field value; normalize to ''.
      locator: doc.locator ?? '',
      quote: caption || chunkOpening(doc.chunk),
    });
    if (docs.length >= topK) break;
  }
  return docs;
}

/**
 * Fallback citation quote when the ranker returns no caption: the chunk's
 * opening, cut at a sentence boundary near 200 chars.
 */
function chunkOpening(chunk: string): string {
  const head = chunk.slice(0, 300);
  if (head.length < 300) return head.trim();
  const sentenceEnd = head.slice(120).search(/[.!?]\s/);
  if (sentenceEnd >= 0) {
    return head.slice(0, 120 + sentenceEnd + 1).trim();
  }
  return `${head.slice(0, 200).trim()}…`;
}
