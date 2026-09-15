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
 * partitioned by `agent_id`, `source_id`, `drive_id` and `item_id` filters. Retrieval
 * is ALWAYS filtered to what the requesting user's own token can open
 * (layer-2 trim — see agentSourceAccess.ts): by source for file sources,
 * per child file for folder sources. There is no unfiltered read path.
 */
import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import type {
  M365Agent,
  M365AgentManifest,
  M365DerivedIndexEntry,
  M365IndexJob,
  M365IndexJobSource,
  M365ManifestItem,
  M365SourceChanges,
} from '@/lib/services/agentAccess/types';
import {
  chunkRetentionFor,
  selectStaleChunkIds,
} from '@/lib/services/m365/agentIndexJobStore';
import {
  ENUMERATION_CEILING,
  MAX_M365_AGENT_DOCUMENTS,
  MAX_M365_AGENT_SOURCE_BYTES,
  MAX_M365_SOURCE_FILE_BYTES,
  RefreshSourcePlan,
  SourcePlan,
  effectiveMaxDocuments,
  extensionOf,
  planSource,
  refreshSourcePlan,
  sumChanges,
} from '@/lib/services/m365/agentSourcePlanner';
import { checkDocumentSignature } from '@/lib/services/m365/documentSignature';
import {
  M365Error,
  fetchWithGraphRetry,
  graphErrorFromResponse,
  graphFetch,
  graphJson,
} from '@/lib/services/m365/graphApi';

import {
  NoExtractableTextError,
  countPdfPages,
  loadDocument,
} from '@/lib/utils/server/file/fileHandling';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';
import { randomUUID } from 'crypto';

// Caps live with the planner (the plan view and the index run must agree);
// re-exported so existing importers keep working.
export { MAX_M365_AGENT_DOCUMENTS, MAX_M365_SOURCE_FILE_BYTES };

const GRAPH_SCOPES = ['Files.ReadWrite.All'];
/**
 * Extraction runs external tools on attacker-controlled bytes; the tools
 * carry their own process timeouts (pandoc 180s) but a stuck extractor
 * must not stall the whole run. The race doesn't kill the child — it
 * just moves on and reports the item as failed.
 */
const EXTRACTION_TIMEOUT_MS = 180_000;
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
  /**
   * Sanitized Graph drive id. Item ids are only unique within a drive, so
   * the folder trim filters on (drive_id, item_id) pairs. Chunks written
   * before this field existed have no value; see buildM365AccessFilter.
   */
  drive_id?: string;
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
      { name: 'drive_id', type: 'Edm.String', filterable: true },
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
  name?: string;
  size?: number;
  eTag?: string;
  lastModifiedDateTime?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

/**
 * Pre-authenticated download URLs come back from Graph metadata, never
 * from user input — but the item ids that lead to them are stored
 * strings. Only follow hosts Microsoft serves file content from; anything
 * else falls back to the token-authenticated /content endpoint.
 */
const DOWNLOAD_HOST_SUFFIXES = [
  '.sharepoint.com',
  '.sharepoint-df.com',
  '.sharepoint.us',
  '.sharepoint.de',
  '.sharepoint.cn',
  '.files.1drv.com',
];

export function isAllowedDownloadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'graph.microsoft.com') return true;
  return DOWNLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Time-boxes `run` and ABORTS it on expiry: the AbortSignal handed to the
 * task is forwarded to every converter child the extraction spawns, so a
 * stuck pandoc/LibreOffice/ssconvert is killed instead of lingering on
 * the replica after the item has already been recorded as failed.
 */
export function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface DownloadedItem {
  buffer: Buffer;
  name: string;
  eTag?: string;
  lastModified?: string;
}

/**
 * Downloads one item's bytes with the caller's token. Re-checks the size
 * Graph reports now against `maxBytes` before and after the transfer, and
 * only follows pre-authenticated download URLs on Microsoft hosts.
 */
export async function downloadItemBytes(
  req: NextRequest,
  driveId: string,
  itemId: string,
  fallbackName: string,
  maxBytes: number = MAX_M365_SOURCE_FILE_BYTES,
): Promise<DownloadedItem> {
  const meta = await graphJson<GraphItemMeta>(
    req,
    GRAPH_SCOPES,
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}` +
      '?$select=name,size,eTag,lastModifiedDateTime,@microsoft.graph.downloadUrl',
  );
  if ((meta.size ?? 0) > maxBytes) {
    throw new M365Error(
      `File exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit`,
      'graph_error',
      400,
    );
  }
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const content =
    downloadUrl && isAllowedDownloadUrl(downloadUrl)
      ? await fetchWithGraphRetry(downloadUrl)
      : await graphFetch(
          req,
          GRAPH_SCOPES,
          `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
        );
  if (!content.ok) {
    // The pre-authenticated URL is not a Graph endpoint, but its failure
    // modes map the same way: 401/403/404 mean the file is gone or the
    // caller lost access (→ `missing` on the item), anything else is a
    // transport problem worth retrying next run.
    throw await graphErrorFromResponse(
      content,
      'Failed to download file content',
    );
  }
  const buffer = Buffer.from(await content.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new M365Error(
      'Downloaded content exceeds the limit',
      'graph_error',
      400,
    );
  }
  return {
    buffer,
    name: meta.name ?? fallbackName,
    ...(meta.eTag && { eTag: meta.eTag }),
    ...(meta.lastModifiedDateTime && {
      lastModified: meta.lastModifiedDateTime,
    }),
  };
}

/**
 * Downloads one planned item and extracts its text. The planner already
 * vetted type and size from metadata; this verifies the bytes match the
 * extension before the extraction toolchain sees them.
 */
async function downloadAndExtract(
  req: NextRequest,
  item: M365ManifestItem,
): Promise<{
  text: string;
  lastModified?: string;
  /** The downloaded bytes, so an OCR pass needs no second download. */
  buffer: Buffer;
  name: string;
}> {
  const downloaded = await downloadItemBytes(
    req,
    item.driveId,
    item.itemId,
    item.name,
  );
  const signature = checkDocumentSignature(
    downloaded.buffer,
    extensionOf(downloaded.name),
  );
  if (!signature.ok) {
    throw new Error(signature.error ?? 'File content does not match its type');
  }
  const file = new File([new Uint8Array(downloaded.buffer)], downloaded.name);
  let text: string;
  try {
    text = await withTimeout(
      (signal) => loadDocument(file, { signal }),
      EXTRACTION_TIMEOUT_MS,
      'Extraction',
    );
  } catch (error) {
    // A well-formed PDF with no text layer is not a failure of this item;
    // it is the `noText` outcome (and auto-OCR's input). Real extraction
    // failures keep propagating with their reasons.
    if (error instanceof NoExtractableTextError) {
      text = '';
    } else {
      throw error;
    }
  }
  return {
    text,
    lastModified: downloaded.lastModified,
    buffer: downloaded.buffer,
    name: downloaded.name,
  };
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
  // Collect keys page by page, then delete. Bounded: the document cap ×
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

/**
 * Documents processed concurrently per step. Each document is itself
 * sequential (download → extract → embed → upload); 3 in flight keeps a
 * batch well inside a step's time box without hammering Graph or the
 * extraction toolchain (pandoc/LibreOffice are process-per-file).
 */
export const DOCUMENT_INDEX_CONCURRENCY = 3;

export async function mapWithConcurrency<T, R>(
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
 * Plans every source (metadata only) so the cap is enforced before any
 * download, exactly as the plan endpoint reports it. A source whose
 * enumeration fails becomes an `error` job source rather than aborting
 * the run — except for session-level failures (no Graph session, consent
 * gap), which are the caller's to surface.
 */
function isRefreshPlan(
  plan: SourcePlan | RefreshSourcePlan,
): plan is RefreshSourcePlan {
  return 'changes' in plan && 'incremental' in plan;
}

async function planJobSources(
  req: NextRequest,
  agent: M365Agent,
  userId: string,
  manifest: M365AgentManifest | null = null,
  prepared: Record<string, M365DerivedIndexEntry> | undefined = undefined,
  options: { enforceCaps?: boolean } = {},
): Promise<M365IndexJobSource[]> {
  const enforceCaps = options.enforceCaps ?? true;
  const manifestBySourceId = new Map(
    (manifest?.sources ?? []).map((s) => [s.sourceId, s]),
  );
  const sources: M365IndexJobSource[] = [];
  for (const source of agent.sources) {
    const base: M365IndexJobSource = {
      sourceId: source.sourceId,
      status: 'pending',
      truncated: false,
      folders: [],
      items: [],
    };
    try {
      const input = {
        sourceId: source.sourceId,
        driveId: source.driveId,
        itemId: source.itemId,
        kind: source.kind,
        recursive: source.recursive,
        excludedItemIds: source.excludedItemIds,
        includeExtensions: source.includeExtensions,
        prepared,
      };
      // Refresh: sources with a manifest entry plan incrementally against
      // it (unchanged items keep their outcome); sources added since the
      // last run are planned in full like a first index.
      const previous = manifestBySourceId.get(source.sourceId);
      const plan: SourcePlan | RefreshSourcePlan = previous
        ? await refreshSourcePlan(req, input, previous)
        : await planSource(req, userId, input);
      const refresh = isRefreshPlan(plan) ? plan : null;
      if (plan.missing) {
        sources.push({
          ...base,
          status: 'missing',
          error: 'The file or folder could not be opened with your account',
        });
        continue;
      }
      sources.push({
        ...base,
        truncated: plan.truncated,
        ...(plan.deltaLink && { deltaLink: plan.deltaLink }),
        ...(refresh && {
          changes: refresh.changes,
          incremental: refresh.incremental,
        }),
        folders: plan.folders,
        // Refresh plans arrive with carried-over statuses; full plans
        // start every indexable item pending.
        items: refresh
          ? plan.items
          : plan.items.map((item) =>
              item.tier === 'indexable'
                ? {
                    ...item,
                    status: 'pending',
                    indexedChunks: undefined,
                    error: undefined,
                  }
                : {
                    ...item,
                    status: undefined,
                    indexedChunks: undefined,
                    error: undefined,
                  },
            ),
      });
    } catch (error) {
      if (
        error instanceof M365Error &&
        (error.kind === 'not_connected' || error.kind === 'consent_missing')
      ) {
        throw error;
      }
      console.error(
        `[m365-agents] planning failed for agent ${sanitizeForLog(agent.id)} source ${sanitizeForLog(source.sourceId)}: ${sanitizeForLog(error)}`,
      );
      sources.push({
        ...base,
        status: 'error',
        error:
          error instanceof Error
            ? error.message.slice(0, 300)
            : 'Could not list the source',
      });
    }
  }

  if (!enforceCaps) return sources;
  const verdict = assessPlannedSources(sources, agent);
  // A truncated listing would index an arbitrary first slice of a library
  // and present it as the whole thing — refuse, like the save does.
  if (verdict.truncatedSourceId) {
    throw new M365Error(
      `Source ${verdict.truncatedSourceId} is too large to scan completely (more than ${ENUMERATION_CEILING} matching items) — pick a subfolder or narrow the file-type filter`,
      'graph_error',
      400,
    );
  }
  if (verdict.overCap) {
    throw new M365Error(
      `Agent expands to ${verdict.totalDocuments} documents, more than the ${verdict.maxDocuments} allowed — exclude subfolders, filter by type, or remove sources`,
      'graph_error',
      400,
    );
  }
  const { totalBytes } = verdict;
  if (totalBytes > MAX_M365_AGENT_SOURCE_BYTES) {
    throw new M365Error(
      `Agent sources total ${Math.round(totalBytes / (1024 * 1024))}MB, more than the ${Math.round(MAX_M365_AGENT_SOURCE_BYTES / (1024 * 1024))}MB allowed — exclude subfolders or large files`,
      'graph_error',
      400,
    );
  }
  return sources;
}

/**
 * Builds a fresh job for the agent using the CALLING ADMIN'S Graph token:
 * resolves the embedding deployment, plans every source, and lists every
 * indexable item as `pending`. Nothing is downloaded here; steps do that.
 */
export interface PrepareIndexJobOptions {
  mode: 'full' | 'refresh';
  /** Required for `refresh`; the last run's per-item record. */
  manifest?: M365AgentManifest | null;
  /** The agent's prepared files (phase 4), from the derived index. */
  prepared?: Record<string, M365DerivedIndexEntry>;
}

export async function prepareIndexJob(
  req: NextRequest,
  agent: M365Agent,
  userId: string,
  startedBy: string,
  options: PrepareIndexJobOptions = { mode: 'full' },
): Promise<M365IndexJob> {
  await ensureM365AgentsIndex();
  const embeddingDeployment = await resolveEmbeddingDeployment(agent);
  // A refresh must embed with the deployment the kept chunks used; if the
  // deployment changed, carried-over chunks would not match query vectors.
  const refresh =
    options.mode === 'refresh' &&
    !!options.manifest &&
    (!agent.embeddingModelId || agent.embeddingModelId === embeddingDeployment);
  const sources = await planJobSources(
    req,
    agent,
    userId,
    refresh ? options.manifest : null,
    options.prepared,
  );
  const now = new Date().toISOString();
  return {
    version: 1,
    jobId: `job-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    agentId: agent.id,
    status: 'running',
    startedBy,
    startedAt: now,
    ocrPagesUsed: 0,
    updatedAt: now,
    embeddingDeployment,
    mode: refresh ? 'refresh' : 'full',
    ...(refresh && {
      changes: sumChanges(
        sources
          .map((s) => s.changes)
          .filter((c): c is M365SourceChanges => !!c),
      ),
    }),
    sources,
  };
}

export interface RefreshPreviewSource {
  sourceId: string;
  changes: M365SourceChanges;
  incremental: boolean;
  missing: boolean;
  error?: string;
}

/** Reported by the preview instead of thrown: the banner says it, Refresh stays disabled. */
export interface RefreshOverCap {
  totalDocuments: number;
  maxDocuments: number;
}

/**
 * Cap verdict over planned sources (pure): what an index run would refuse.
 * Shared by the enforcing path (throws) and the preview (reports).
 */
export function assessPlannedSources(
  sources: Pick<M365IndexJobSource, 'sourceId' | 'truncated' | 'items'>[],
  agent: Pick<M365Agent, 'maxDocumentsOverride'>,
): {
  totalDocuments: number;
  maxDocuments: number;
  overCap: boolean;
  totalBytes: number;
  truncatedSourceId?: string;
} {
  const indexable = sources
    .flatMap((s) => s.items)
    .filter((i) => i.tier === 'indexable');
  const totalDocuments = indexable.length;
  const maxDocuments = effectiveMaxDocuments(agent.maxDocumentsOverride);
  const truncated = sources.find((s) => s.truncated);
  return {
    totalDocuments,
    maxDocuments,
    overCap: totalDocuments > maxDocuments,
    totalBytes: indexable.reduce((n, item) => n + item.size, 0),
    ...(truncated && { truncatedSourceId: truncated.sourceId }),
  };
}

/**
 * "What would a refresh do?" — the change detection behind the editor's
 * banner (design §7). Metadata only; no job, no writes. Cap problems a
 * refresh would refuse are returned as data (`overCap`, `truncated`), not
 * thrown: the admin opened the editor to fix exactly that.
 */
export async function previewRefresh(
  req: NextRequest,
  agent: M365Agent,
  userId: string,
  manifest: M365AgentManifest,
  prepared?: Record<string, M365DerivedIndexEntry>,
): Promise<{
  sources: RefreshPreviewSource[];
  changes: M365SourceChanges;
  overCap?: RefreshOverCap;
  truncated?: boolean;
}> {
  const planned = await planJobSources(req, agent, userId, manifest, prepared, {
    enforceCaps: false,
  });
  const verdict = assessPlannedSources(planned, agent);
  const overCap = verdict.overCap
    ? {
        totalDocuments: verdict.totalDocuments,
        maxDocuments: verdict.maxDocuments,
      }
    : undefined;
  const truncated = verdict.truncatedSourceId !== undefined || undefined;
  const sources = planned.map(
    (s): RefreshPreviewSource => ({
      sourceId: s.sourceId,
      changes: s.changes ?? { added: 0, modified: 0, removed: 0, unchanged: 0 },
      incremental: s.incremental ?? false,
      missing: s.status === 'missing',
      ...(s.error && { error: s.error }),
    }),
  );
  return {
    sources,
    changes: sumChanges(sources.map((s) => s.changes)),
    ...(overCap && { overCap }),
    ...(truncated && { truncated }),
  };
}

/**
 * Processes ONE planned item end to end — download → validate → extract
 * → chunk → embed → upload — and returns the item with its outcome.
 * Chunk ids are deterministic (`agent_source_item_index`), so re-running
 * an item after an interrupted step is idempotent.
 */
/** Reads a prepared item's derived text (phase 4); null when absent. */
export type DerivedTextReader = (
  itemId: string,
) => Promise<{ eTag: string; text: string } | null>;

/**
 * Auto-OCR budget for one index run, SHARED by every item of a batch
 * (items run concurrently). `remainingPages` is decremented synchronously
 * — before any await on the OCR call — so the per-run cap stays hard even
 * with three items in flight; a failed or unavailable OCR refunds its
 * reservation. OCR is billed per page, hence both caps.
 */
export interface AutoOcrBudget {
  remainingPages: number;
  maxPagesPerFile: number;
}

/** OCR text produced by the auto-OCR path, offered to the caller to cache. */
export interface AutoOcrOutput {
  itemId: string;
  name: string;
  eTag: string;
  text: string;
  pages: number;
  engine: 'di' | 'vision';
}

export interface IndexJobItemOptions {
  /** Present when the agent has `autoOcr` on and the run still has budget. */
  autoOcr?: AutoOcrBudget;
  /**
   * Cache hook for auto-OCR text (billed per page): the job service stores
   * it as a derived-text record keyed by the item's eTag, so a later
   * Re-index all reads the cache instead of paying for the same pages
   * again. Failures to cache never fail the item.
   */
  persistOcr?: (output: AutoOcrOutput) => Promise<void>;
  signal?: AbortSignal;
}

function noTextOutcome(
  item: M365ManifestItem,
  extra: Pick<M365ManifestItem, 'ocrPages' | 'ocrSkipped'> = {},
): M365ManifestItem {
  return {
    ...item,
    status: 'noText',
    indexedChunks: 0,
    error: undefined,
    ocrPages: undefined,
    ocrSkipped: undefined,
    ...extra,
  };
}

export async function indexJobItem(
  req: NextRequest,
  agentId: string,
  embeddingDeployment: string,
  sourceId: string,
  item: M365ManifestItem,
  readDerived?: DerivedTextReader,
  options: IndexJobItemOptions = {},
): Promise<M365ManifestItem> {
  try {
    let text: string;
    let lastModified: string | undefined;
    let pdfBytes: { buffer: Buffer; name: string } | undefined;
    let ocrPages: number | undefined;
    if (item.prepared) {
      // Prepared file: the derived text stands in for extraction. It must
      // match the item's current eTag — otherwise the file changed after
      // preparation and the admin has to prepare it again.
      const derived = readDerived ? await readDerived(item.itemId) : null;
      if (!derived || derived.eTag !== item.eTag) {
        throw new Error(
          'Prepared text is missing or outdated — prepare the file again',
        );
      }
      text = derived.text;
      lastModified = item.lastModified;
    } else {
      const extracted = await downloadAndExtract(req, item);
      ({ text, lastModified } = extracted);
      if (extensionOf(extracted.name) === 'pdf') {
        pdfBytes = { buffer: extracted.buffer, name: extracted.name };
      }
    }
    let chunks = chunkDocument(text);
    if (chunks.length === 0) {
      console.warn(
        `[m365-agents] extraction yielded no text for agent ${sanitizeForLog(agentId)} item ${sanitizeForLog(item.itemId)} (scanned/image-only file?)`,
      );
      const budget = options.autoOcr;
      if (!budget || !pdfBytes) return noTextOutcome(item);

      // Auto-OCR: only within the run's page budget and the per-file cap.
      let pages: number;
      try {
        pages = await countPdfPages(pdfBytes.buffer, {
          signal: options.signal,
        });
      } catch (countError) {
        console.warn(
          `[m365-agents] could not count pages for ${sanitizeForLog(item.itemId)}; leaving as noText: ${sanitizeForLog(countError)}`,
        );
        return noTextOutcome(item);
      }
      if (pages > budget.maxPagesPerFile) {
        return noTextOutcome(item, { ocrSkipped: 'tooManyPages' });
      }
      if (pages > budget.remainingPages) {
        return noTextOutcome(item, { ocrSkipped: 'budget' });
      }
      // Reserve synchronously (same tick) so concurrent items cannot
      // oversubscribe the shared budget while this OCR call is in flight.
      budget.remainingPages -= pages;
      const { OcrEngineUnavailableError, ocrPdfBuffer } =
        await import('@/lib/services/m365/agentPreparationService');
      let ocrText: string;
      try {
        const result = await ocrPdfBuffer(pdfBytes.buffer, pdfBytes.name, {
          maxPages: pages,
          signal: options.signal,
        });
        ocrText = result.text;
        ocrPages = result.pages;
        if (options.persistOcr && item.eTag && ocrText.trim()) {
          try {
            await options.persistOcr({
              itemId: item.itemId,
              name: pdfBytes.name,
              eTag: item.eTag,
              text: ocrText,
              pages: result.pages,
              engine: result.engine,
            });
          } catch (cacheError) {
            console.warn(
              `[m365-agents] could not cache auto-OCR text for ${sanitizeForLog(item.itemId)}: ${sanitizeForLog(cacheError)}`,
            );
          }
        }
      } catch (ocrError) {
        budget.remainingPages += pages;
        if (ocrError instanceof OcrEngineUnavailableError) {
          return noTextOutcome(item, { ocrSkipped: 'engineUnavailable' });
        }
        return {
          ...item,
          status: 'failed',
          indexedChunks: 0,
          ocrPages: undefined,
          ocrSkipped: undefined,
          error: `OCR: ${
            ocrError instanceof Error
              ? ocrError.message.slice(0, 280)
              : 'Unknown error'
          }`,
        };
      }
      chunks = chunkDocument(ocrText);
      if (chunks.length === 0) {
        // Paid for the pages, found nothing (blank scan): keep the count so
        // the run's usage is honest, and leave the Prepare offer in place.
        return noTextOutcome(item, { ocrPages });
      }
    }
    const vectors = await embedTexts(
      chunks.map((c) => c.chunk),
      embeddingDeployment,
    );
    const itemId = sanitizeGraphId(item.itemId);
    const docs = chunks.map(
      (chunk, index): M365AgentIndexDoc => ({
        chunk_id: `${agentId}_${sourceId}_${itemId}_${index}`,
        agent_id: agentId,
        source_id: sourceId,
        item_id: itemId,
        drive_id: sanitizeGraphId(item.driveId),
        locator: chunk.locator ?? '',
        chunk: chunk.chunk,
        title: item.name,
        url: item.webUrl,
        date: lastModified ?? item.lastModified ?? new Date().toISOString(),
        text_vector: vectors[index],
      }),
    );
    await getSearchClient().mergeOrUploadDocuments(docs);
    return {
      ...item,
      status: 'indexed',
      indexedChunks: docs.length,
      error: undefined,
      ocrPages,
      ocrSkipped: undefined,
    };
  } catch (error) {
    if (
      error instanceof M365Error &&
      (error.kind === 'not_connected' || error.kind === 'consent_missing')
    ) {
      // Session-level: no item after this one can succeed either. Let the
      // step end the job loudly instead of failing items one by one with
      // an AADSTS string each.
      throw error;
    }
    const missing =
      error instanceof M365Error &&
      (error.kind === 'not_found' || error.kind === 'forbidden');
    console.error(
      `[m365-agents] indexing failed for agent ${sanitizeForLog(agentId)} item ${sanitizeForLog(item.itemId)}: ${sanitizeForLog(error)}`,
    );
    return {
      ...item,
      status: missing ? 'missing' : 'failed',
      indexedChunks: 0,
      error:
        error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
    };
  }
}

/** Every chunk id currently in the index for the agent, keyset-paged. */
async function listAgentChunkIds(
  client: SearchClient<M365AgentIndexDoc>,
  agentId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let last: string | null = null;
  for (;;) {
    const filter: string =
      `agent_id eq '${odataEscape(agentId)}'` +
      (last ? ` and chunk_id gt '${odataEscape(last)}'` : '');
    const results = await client.search('*', {
      filter,
      select: ['chunk_id'],
      orderBy: ['chunk_id asc'],
      top: 1000,
    });
    let count = 0;
    for await (const result of results.results) {
      ids.push(result.document.chunk_id);
      last = result.document.chunk_id;
      count += 1;
    }
    if (count < 1000) return ids;
  }
}

/**
 * End-of-run diff (design §4): removes chunks the finished job no longer
 * accounts for — items that left the plan, shrank, or lost their text —
 * while keeping the previous chunks of items that failed this run and of
 * sources whose plan failed. Runs AFTER every new chunk is uploaded, so
 * users mid-chat never see an empty index during a re-index.
 */
export async function reconcileAgentChunks(job: M365IndexJob): Promise<number> {
  await ensureM365AgentsIndex();
  const client = getSearchClient();
  const existing = await listAgentChunkIds(client, job.agentId);
  const stale = selectStaleChunkIds(
    existing,
    chunkRetentionFor(job, sanitizeGraphId),
  );
  for (let offset = 0; offset < stale.length; offset += 1000) {
    await client.deleteDocuments(
      'chunk_id',
      stale.slice(offset, offset + 1000),
    );
  }
  return stale.length;
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

/** A child file the requesting user may read, addressed within its drive. */
export interface AccessibleFolderItem {
  driveId: string;
  itemId: string;
}

/**
 * Hybrid vector+semantic retrieval over the agent's chunks, HARD-FILTERED
 * to what the requesting user's own token can open. File-kind sources are
 * trimmed by source_id; folder-kind sources are trimmed PER CHILD FILE via
 * (drive_id, item_id) pairs (`accessibleFolderItems` from
 * agentSourceAccess) — a folder-level verdict alone would leak
 * item-restricted children, and an item id alone is only unique within
 * its drive. Never call this with unverified access lists — the filter IS
 * the layer-2 enforcement.
 */
/**
 * Builds the layer-2 access filter, or null when nothing may be read.
 * Exported for tests — this string IS the enforcement boundary.
 *
 * Folder items are grouped by drive: `(drive_id eq 'D' and
 * search.in(item_id, …))` per drive. Chunks indexed before `drive_id`
 * existed carry no drive; they stay reachable through a `drive_id eq null`
 * clause over the same item ids until a full re-index rewrites them
 * (Refresh carries unchanged chunks over as-is).
 */
export function buildM365AccessFilter(
  agent: M365Agent,
  accessibleSourceIds: string[],
  accessibleFolderItems: AccessibleFolderItem[],
): string | null {
  if (accessibleSourceIds.length === 0) return null;

  const kindBySourceId = new Map(
    agent.sources.map((source) => [source.sourceId, source.kind]),
  );
  const fileSourceList = accessibleSourceIds
    .filter((id) => kindBySourceId.get(id) !== 'folder')
    .map((id) => id.replace(/[^A-Za-z0-9_-]/g, ''))
    .join(',');

  const itemsByDrive = new Map<string, string[]>();
  for (const item of accessibleFolderItems) {
    const driveId = sanitizeGraphId(item.driveId);
    const itemId = sanitizeGraphId(item.itemId);
    if (!driveId || !itemId) continue;
    const list = itemsByDrive.get(driveId) ?? [];
    if (!list.includes(itemId)) list.push(itemId);
    itemsByDrive.set(driveId, list);
  }

  const accessClauses: string[] = [];
  if (fileSourceList) {
    accessClauses.push(`search.in(source_id, '${fileSourceList}', ',')`);
  }
  for (const [driveId, itemIds] of itemsByDrive) {
    accessClauses.push(
      `(drive_id eq '${driveId}' and search.in(item_id, '${itemIds.join(',')}', ','))`,
    );
  }
  if (itemsByDrive.size > 0) {
    const allItems = [...new Set([...itemsByDrive.values()].flat())].join(',');
    accessClauses.push(
      `(drive_id eq null and search.in(item_id, '${allItems}', ','))`,
    );
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
  accessibleFolderItems: AccessibleFolderItem[] = [],
): Promise<M365AgentSearchDoc[]> {
  const filter = buildM365AccessFilter(
    agent,
    accessibleSourceIds,
    accessibleFolderItems,
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
