import { Session } from 'next-auth';

import {
  AGENT_ACCESS_CONFIG_PATH,
  AGENT_ACCESS_CONNECTORS_PREFIX,
  AGENT_ACCESS_GUIDES_PREFIX,
  AGENT_ACCESS_MAP_DATASET_META_PREFIX,
  AGENT_ACCESS_PROMPT_AGENTS_PREFIX,
  AGENT_ACCESS_RULES_PREFIX,
  AgentAccessConfig,
  AgentAccessConfigSchema,
  AgentAccessHistoryEntry,
  AgentAccessHistoryEntrySchema,
  AgentAccessRule,
  AgentAccessRuleSchema,
  GUIDE_SOURCE,
  Guide,
  GuideHistoryEntry,
  GuideHistoryEntrySchema,
  GuideSchema,
  MAP_DATASET_SOURCE,
  MCP_CONNECTOR_SOURCE,
  MapDataset,
  MapDatasetHistoryEntry,
  MapDatasetHistoryEntrySchema,
  MapDatasetMeta,
  MapDatasetMetaSchema,
  MapDatasetSchema,
  McpConnector,
  McpConnectorHistoryEntry,
  McpConnectorHistoryEntrySchema,
  McpConnectorSchema,
  PROMPT_AGENT_SOURCE,
  PromptAgent,
  PromptAgentHistoryEntry,
  PromptAgentHistoryEntrySchema,
  PromptAgentSchema,
  canonicalAgentKey,
  connectorBlobPath,
  guideBlobPath,
  historyBlobPath,
  mapDatasetDataBlobPath,
  mapDatasetMeta,
  mapDatasetMetaBlobPath,
  promptAgentBlobPath,
  ruleBlobPath,
} from '@/lib/services/agentAccess/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { AzureBlobStorage, BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

/**
 * Blob persistence for agent access rules, config, and history.
 *
 * Mirrors the backup-manifest CAS pattern
 * (lib/services/backup/server/backupBlobStore.ts):
 *
 * ⚠ Writes deliberately bypass `AzureBlobStorage.upload()`: its same-byte-
 * length dedupe silently drops writes whose new content happens to match the
 * stored length — fatal for rule JSON that stays the same size across edits.
 * We use `getBlockBlobClient().upload` with ETag conditions instead
 * (`ifMatch` for updates, `ifNoneMatch: '*'` for creates). `withAzureRetry`
 * only retries 5xx/network errors, so a 412 precondition failure surfaces
 * immediately (no retry) and is translated here into
 * {@link AgentAccessConflictError} (routes map it to 409).
 */

/**
 * Thrown when an ETag precondition fails on a rule/config write — another
 * admin (or replica) won the compare-and-swap. Routes map this to 409.
 */
export class AgentAccessConflictError extends Error {
  constructor(message = 'Agent access blob was modified concurrently') {
    super(message);
    this.name = 'AgentAccessConflictError';
  }
}

export interface StoredAgentAccessRule {
  canonicalKey: string;
  blobPath: string;
  rule: AgentAccessRule;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface ConfigReadResult {
  config: AgentAccessConfig;
  etag: string;
}

export interface RuleReadResult {
  rule: AgentAccessRule;
  etag: string;
}

export interface StoredPromptAgent {
  /** `prompt-agent::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  agent: PromptAgent;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface PromptAgentReadResult {
  agent: PromptAgent;
  etag: string;
}

export interface StoredMcpConnector {
  /** `mcp-connector::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  connector: McpConnector;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface McpConnectorReadResult {
  connector: McpConnector;
  etag: string;
}

export interface StoredGuide {
  /** `guide::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  guide: Guide;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface GuideReadResult {
  guide: Guide;
  etag: string;
}

export interface StoredMapDatasetMeta {
  /** `map-dataset::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  meta: MapDatasetMeta;
}

export interface MapDatasetReadResult {
  dataset: MapDataset;
  /** DATA-blob ETag — the CAS anchor for every dataset write. */
  etag: string;
}

/**
 * Rules always live in the PRIMARY region's storage account (spec: EU
 * replicas read cross-region). Account + container are passed explicitly so
 * `getEnvVariable`'s per-user EU mapping never applies; this placeholder user
 * is therefore never consulted for region routing.
 */
const SYSTEM_USER: Session['user'] = {
  id: 'system-agent-access',
  displayName: 'agent-access-control',
};

export function createAgentAccessBlobStorage(): BlobStorage {
  const accountName = env.AZURE_BLOB_STORAGE_NAME;
  // Same fallback convention as blobStorageFactory: environments without a
  // dedicated container use the image container for all app storage.
  const containerName =
    env.AZURE_BLOB_STORAGE_CONTAINER ?? env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER;
  if (!accountName || !containerName) {
    throw new Error(
      'Agent access control requires AZURE_BLOB_STORAGE_NAME and a container (AZURE_BLOB_STORAGE_CONTAINER or AZURE_BLOB_STORAGE_IMAGE_CONTAINER)',
    );
  }
  return new AzureBlobStorage(accountName, containerName, SYSTEM_USER);
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

async function streamToBuffer(
  readableStream: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => resolve(Buffer.concat(chunks)));
    readableStream.on('error', reject);
  });
}

async function downloadBlob(
  storage: BlobStorage,
  blobPath: string,
): Promise<{ buffer: Buffer; etag: string } | null> {
  const client = storage.getBlockBlobClient(blobPath);
  try {
    return await withAzureRetry(
      async () => {
        const response = await client.download();
        if (!response.readableStreamBody) {
          throw new Error(`No readable stream for blob ${blobPath}`);
        }
        const buffer = await streamToBuffer(response.readableStreamBody);
        return { buffer, etag: response.etag ?? '' };
      },
      { label: 'agentAccess.downloadBlob' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

async function uploadJson(
  storage: BlobStorage,
  blobPath: string,
  payload: unknown,
  ifMatchEtag: string | null,
  label: string,
): Promise<string> {
  const client = storage.getBlockBlobClient(blobPath);
  const content = Buffer.from(JSON.stringify(payload), 'utf8');
  try {
    const response = await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: ifMatchEtag
            ? { ifMatch: ifMatchEtag }
            : { ifNoneMatch: '*' },
        }),
      { label },
    );
    return response.etag ?? '';
  } catch (error) {
    if (statusCodeOf(error) === 412) {
      throw new AgentAccessConflictError();
    }
    throw error;
  }
}

/** Reads and parses the delegation config. Returns null when none exists. */
export async function readConfig(
  storage: BlobStorage,
): Promise<ConfigReadResult | null> {
  const result = await downloadBlob(storage, AGENT_ACCESS_CONFIG_PATH);
  if (result === null) return null;
  const config = AgentAccessConfigSchema.parse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  return { config, etag: result.etag };
}

/**
 * Compare-and-swap config write. `ifMatchEtag` null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}.
 * Returns the new ETag.
 */
export async function writeConfig(
  storage: BlobStorage,
  config: AgentAccessConfig,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = AgentAccessConfigSchema.parse(config);
  return uploadJson(
    storage,
    AGENT_ACCESS_CONFIG_PATH,
    parsed,
    ifMatchEtag,
    'agentAccess.writeConfig',
  );
}

/**
 * Lists and parses every rule blob under the rules prefix.
 *
 * SECURITY: a malformed blob (bad JSON, schema failure, or a blob whose name
 * does not match its content's canonical-key hash — i.e. hand-placed) makes
 * the whole listing THROW after logging. Under deny-list semantics a
 * silently-skipped restricted rule would fail OPEN — the agent would become
 * visible to everyone. Failing the refresh instead keeps the last-known-good
 * ruleset on warm replicas (restriction preserved) and hits the documented
 * fail-closed 'unavailable' path on cold start. The ONLY silent skip is a
 * 404 — the blob was deleted between list and get, a benign race.
 */
export async function listAllRules(
  storage: BlobStorage,
): Promise<StoredAgentAccessRule[]> {
  const names = await storage.listBlobs(AGENT_ACCESS_RULES_PREFIX);
  const results = await Promise.all(
    names.map(async (name): Promise<StoredAgentAccessRule | null> => {
      // 404 → deleted between list and get; skip silently.
      const downloaded = await downloadBlob(storage, name);
      if (downloaded === null) return null;

      let json: unknown;
      try {
        json = JSON.parse(downloaded.buffer.toString('utf8'));
      } catch {
        console.error(
          `[agent-access] rule blob with invalid JSON fails the listing (fail closed): ${sanitizeForLog(name)}`,
        );
        throw new Error(`Agent access rule blob has invalid JSON: ${name}`);
      }
      const parsed = AgentAccessRuleSchema.safeParse(json);
      if (!parsed.success) {
        console.error(
          `[agent-access] malformed rule blob fails the listing (fail closed) ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
        );
        throw new Error(
          `Malformed agent access rule blob ${name}: ${parsed.error.message}`,
        );
      }
      const key = canonicalAgentKey(parsed.data.source, parsed.data.agentName);
      if (ruleBlobPath(key) !== name) {
        // A stray blob must not shadow (or masquerade as) another key's rule.
        console.error(
          `[agent-access] rule blob whose name does not match its content's canonical key fails the listing (fail closed): ${sanitizeForLog(name)}`,
        );
        throw new Error(
          `Agent access rule blob name does not match its content's canonical key: ${name}`,
        );
      }
      return {
        canonicalKey: key,
        blobPath: name,
        rule: parsed.data,
        etag: downloaded.etag,
      };
    }),
  );
  return results.filter((r): r is StoredAgentAccessRule => r !== null);
}

/** Reads a single rule by canonical key. Returns null when none exists. */
export async function readRule(
  storage: BlobStorage,
  canonicalKey: string,
): Promise<RuleReadResult | null> {
  const result = await downloadBlob(storage, ruleBlobPath(canonicalKey));
  if (result === null) return null;
  const parsed = AgentAccessRuleSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Malformed agent access rule blob for key ${canonicalKey}: ${parsed.error.message}`,
    );
  }
  return { rule: parsed.data, etag: result.etag };
}

/**
 * Compare-and-swap rule write. The blob path is derived from the rule's own
 * source + agentName (canonicalized), so a rule can never land at another
 * key's path. `ifMatchEtag` set → update (`If-Match`); null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}.
 * Returns the new ETag.
 */
export async function writeRule(
  storage: BlobStorage,
  rule: AgentAccessRule,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = AgentAccessRuleSchema.parse(rule);
  const blobPath = ruleBlobPath(
    canonicalAgentKey(parsed.source, parsed.agentName),
  );
  return uploadJson(
    storage,
    blobPath,
    parsed,
    ifMatchEtag,
    'agentAccess.writeRule',
  );
}

/**
 * Conditional rule delete (`If-Match`). Returns false when the blob was
 * already absent (idempotent); 412 → {@link AgentAccessConflictError}.
 */
export async function deleteRule(
  storage: BlobStorage,
  canonicalKey: string,
  ifMatchEtag: string,
): Promise<boolean> {
  const client = storage.getBlockBlobClient(ruleBlobPath(canonicalKey));
  try {
    await withAzureRetry(
      () => client.delete({ conditions: { ifMatch: ifMatchEtag } }),
      { label: 'agentAccess.deleteRule' },
    );
    return true;
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 404) return false;
    if (status === 412) throw new AgentAccessConflictError();
    throw error;
  }
}

/**
 * Appends an immutable history entry (`If-None-Match: *`). History paths are
 * keyed by canonicalKey hash + the entry's own timestamp, so a 412 means an
 * earlier attempt (or a retry) already landed this exact entry — treated as
 * idempotent success.
 */
export async function writeHistoryEntry(
  storage: BlobStorage,
  entry: AgentAccessHistoryEntry,
): Promise<void> {
  const parsed = AgentAccessHistoryEntrySchema.parse(entry);
  const client = storage.getBlockBlobClient(
    historyBlobPath(parsed.canonicalKey, parsed.updatedAt),
  );
  const content = Buffer.from(JSON.stringify(parsed), 'utf8');
  try {
    await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'agentAccess.writeHistoryEntry' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 412) return;
    throw error;
  }
}

/**
 * Lists and parses every prompt-agent blob under the prompt-agents prefix.
 *
 * DELIBERATELY SOFTER than {@link listAllRules}: a malformed blob (bad JSON,
 * schema failure, or a blob whose name does not match its content's
 * id-derived path — i.e. hand-placed) is SKIPPED with a loud console.error
 * instead of failing the whole listing. A dropped persona fails SAFE — it
 * disappears from discovery and its botId falls through to vanilla chat —
 * whereas a dropped rule would fail OPEN, which is why listAllRules throws.
 * Throwing here would couple one corrupt persona blob to the entire rules
 * snapshot (refresh() loads both) and, on cold start, brick every Foundry
 * invocation — exactly the blast radius the sibling `prompt-agents/` prefix
 * exists to contain. Storage-level errors (list/download failures) still
 * throw; a 404 (deleted between list and get) stays a silent skip.
 */
export async function listAllPromptAgents(
  storage: BlobStorage,
): Promise<StoredPromptAgent[]> {
  const names = await storage.listBlobs(AGENT_ACCESS_PROMPT_AGENTS_PREFIX);
  const results = await Promise.all(
    names.map(async (name): Promise<StoredPromptAgent | null> => {
      // 404 → deleted between list and get; skip silently.
      const downloaded = await downloadBlob(storage, name);
      if (downloaded === null) return null;

      let json: unknown;
      try {
        json = JSON.parse(downloaded.buffer.toString('utf8'));
      } catch {
        console.error(
          `[agent-access] SKIPPING prompt-agent blob with invalid JSON (broken persona degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      const parsed = PromptAgentSchema.safeParse(json);
      if (!parsed.success) {
        console.error(
          `[agent-access] SKIPPING malformed prompt-agent blob (broken persona degrades alone; rules snapshot unaffected) ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
        );
        return null;
      }
      if (promptAgentBlobPath(parsed.data.id) !== name) {
        // A stray blob must not shadow (or masquerade as) another id's agent.
        console.error(
          `[agent-access] SKIPPING prompt-agent blob whose name does not match its content's id (broken persona degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      return {
        canonicalKey: canonicalAgentKey(PROMPT_AGENT_SOURCE, parsed.data.id),
        blobPath: name,
        agent: parsed.data,
        etag: downloaded.etag,
      };
    }),
  );
  return results.filter((r): r is StoredPromptAgent => r !== null);
}

/** Reads a single prompt agent by id. Returns null when none exists. */
export async function readPromptAgent(
  storage: BlobStorage,
  id: string,
): Promise<PromptAgentReadResult | null> {
  const result = await downloadBlob(storage, promptAgentBlobPath(id));
  if (result === null) return null;
  const parsed = PromptAgentSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Malformed prompt agent blob for id ${id}: ${parsed.error.message}`,
    );
  }
  return { agent: parsed.data, etag: result.etag };
}

/**
 * Compare-and-swap prompt-agent write. The blob path is derived from the
 * record's own id, so an agent can never land at another id's path.
 * `ifMatchEtag` set → update (`If-Match`); null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}.
 * Returns the new ETag.
 */
export async function writePromptAgent(
  storage: BlobStorage,
  agent: PromptAgent,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = PromptAgentSchema.parse(agent);
  return uploadJson(
    storage,
    promptAgentBlobPath(parsed.id),
    parsed,
    ifMatchEtag,
    'agentAccess.writePromptAgent',
  );
}

/**
 * Conditional prompt-agent delete (`If-Match`). Returns false when the blob
 * was already absent (idempotent); 412 → {@link AgentAccessConflictError}.
 */
export async function deletePromptAgent(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  const client = storage.getBlockBlobClient(promptAgentBlobPath(id));
  try {
    await withAzureRetry(
      () => client.delete({ conditions: { ifMatch: ifMatchEtag } }),
      { label: 'agentAccess.deletePromptAgent' },
    );
    return true;
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 404) return false;
    if (status === 412) throw new AgentAccessConflictError();
    throw error;
  }
}

/**
 * Appends an immutable prompt-agent history entry (`If-None-Match: *`) at
 * `historyBlobPath(canonicalKey)` — same audit namespace as rules. A 412
 * means an earlier attempt (or a retry) already landed this exact entry —
 * treated as idempotent success. Callers wrap this best-effort: a history
 * failure must never fail the mutation (mirror appendHistoryBestEffort).
 */
export async function writePromptAgentHistoryEntry(
  storage: BlobStorage,
  entry: PromptAgentHistoryEntry,
): Promise<void> {
  const parsed = PromptAgentHistoryEntrySchema.parse(entry);
  const client = storage.getBlockBlobClient(
    historyBlobPath(parsed.canonicalKey, parsed.updatedAt),
  );
  const content = Buffer.from(JSON.stringify(parsed), 'utf8');
  try {
    await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'agentAccess.writePromptAgentHistoryEntry' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 412) return;
    throw error;
  }
}

/**
 * Lists every admin-authored MCP connector. Malformed blobs are SKIPPED with a
 * loud log, never thrown — identical rationale to listAllPromptAgents: one
 * corrupt connector must not take down the rules snapshot that refresh()
 * loads alongside it. Storage-level errors still throw.
 */
export async function listAllConnectors(
  storage: BlobStorage,
): Promise<StoredMcpConnector[]> {
  const names = await storage.listBlobs(AGENT_ACCESS_CONNECTORS_PREFIX);
  const results = await Promise.all(
    names.map(async (name): Promise<StoredMcpConnector | null> => {
      // 404 → deleted between list and get; skip silently.
      const downloaded = await downloadBlob(storage, name);
      if (downloaded === null) return null;

      let json: unknown;
      try {
        json = JSON.parse(downloaded.buffer.toString('utf8'));
      } catch {
        console.error(
          `[agent-access] SKIPPING connector blob with invalid JSON (broken connector degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      const parsed = McpConnectorSchema.safeParse(json);
      if (!parsed.success) {
        console.error(
          `[agent-access] SKIPPING malformed connector blob (broken connector degrades alone; rules snapshot unaffected) ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
        );
        return null;
      }
      if (connectorBlobPath(parsed.data.id) !== name) {
        // A stray blob must not shadow (or masquerade as) another id's
        // connector — that would let one land at a trusted id's URL.
        console.error(
          `[agent-access] SKIPPING connector blob whose name does not match its content's id (broken connector degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      return {
        canonicalKey: canonicalAgentKey(MCP_CONNECTOR_SOURCE, parsed.data.id),
        blobPath: name,
        connector: parsed.data,
        etag: downloaded.etag,
      };
    }),
  );
  return results.filter((r): r is StoredMcpConnector => r !== null);
}

/** Reads a single connector by id. Returns null when none exists. */
export async function readConnector(
  storage: BlobStorage,
  id: string,
): Promise<McpConnectorReadResult | null> {
  const result = await downloadBlob(storage, connectorBlobPath(id));
  if (result === null) return null;
  const parsed = McpConnectorSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Malformed connector blob for id ${id}: ${parsed.error.message}`,
    );
  }
  return { connector: parsed.data, etag: result.etag };
}

/**
 * Compare-and-swap connector write. The blob path is derived from the
 * record's own id, so a connector can never land at another id's path — which
 * also keeps the sealed client secret's AAD binding meaningful.
 * `ifMatchEtag` set → update (`If-Match`); null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}.
 * Returns the new ETag.
 */
export async function writeConnector(
  storage: BlobStorage,
  connector: McpConnector,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = McpConnectorSchema.parse(connector);
  return uploadJson(
    storage,
    connectorBlobPath(parsed.id),
    parsed,
    ifMatchEtag,
    'agentAccess.writeConnector',
  );
}

/**
 * Conditional connector delete (`If-Match`). Returns false when the blob was
 * already absent (idempotent); 412 → {@link AgentAccessConflictError}.
 */
export async function deleteConnector(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  const client = storage.getBlockBlobClient(connectorBlobPath(id));
  try {
    await withAzureRetry(
      () => client.delete({ conditions: { ifMatch: ifMatchEtag } }),
      { label: 'agentAccess.deleteConnector' },
    );
    return true;
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 404) return false;
    if (status === 412) throw new AgentAccessConflictError();
    throw error;
  }
}

/**
 * Appends an immutable connector history entry (`If-None-Match: *`) at
 * `historyBlobPath(canonicalKey)` — same audit namespace as rules. A 412
 * means an earlier attempt (or a retry) already landed this exact entry —
 * treated as idempotent success. Callers wrap this best-effort: a history
 * failure must never fail the mutation (mirror appendHistoryBestEffort).
 *
 * The persisted entry carries the connector verbatim, INCLUDING its sealed
 * client secret — sealed, so the audit trail never holds plaintext.
 */
export async function writeConnectorHistoryEntry(
  storage: BlobStorage,
  entry: McpConnectorHistoryEntry,
): Promise<void> {
  const parsed = McpConnectorHistoryEntrySchema.parse(entry);
  const client = storage.getBlockBlobClient(
    historyBlobPath(parsed.canonicalKey, parsed.updatedAt),
  );
  const content = Buffer.from(JSON.stringify(parsed), 'utf8');
  try {
    await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'agentAccess.writeConnectorHistoryEntry' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 412) return;
    throw error;
  }
}

/**
 * Lists every admin-authored workflow guide. Malformed blobs are SKIPPED with
 * a loud log, never thrown — identical rationale to listAllPromptAgents: one
 * corrupt guide must not take down the rules snapshot that refresh() loads
 * alongside it. A skipped guide fails SAFE: its access data lives in the
 * (fail-closed) rules listing, not here, and a guide with no loadable body
 * simply cannot be invoked. Storage-level errors still throw.
 */
export async function listAllGuides(
  storage: BlobStorage,
): Promise<StoredGuide[]> {
  const names = await storage.listBlobs(AGENT_ACCESS_GUIDES_PREFIX);
  const results = await Promise.all(
    names.map(async (name): Promise<StoredGuide | null> => {
      // 404 → deleted between list and get; skip silently.
      const downloaded = await downloadBlob(storage, name);
      if (downloaded === null) return null;

      let json: unknown;
      try {
        json = JSON.parse(downloaded.buffer.toString('utf8'));
      } catch {
        console.error(
          `[agent-access] SKIPPING guide blob with invalid JSON (broken guide degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      const parsed = GuideSchema.safeParse(json);
      if (!parsed.success) {
        console.error(
          `[agent-access] SKIPPING malformed guide blob (broken guide degrades alone; rules snapshot unaffected) ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
        );
        return null;
      }
      if (guideBlobPath(parsed.data.id) !== name) {
        // A stray blob must not shadow (or masquerade as) another id's guide —
        // that would let one land at a trusted id's prompt body.
        console.error(
          `[agent-access] SKIPPING guide blob whose name does not match its content's id (broken guide degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      return {
        canonicalKey: canonicalAgentKey(GUIDE_SOURCE, parsed.data.id),
        blobPath: name,
        guide: parsed.data,
        etag: downloaded.etag,
      };
    }),
  );
  return results.filter((r): r is StoredGuide => r !== null);
}

/** Reads a single guide by id. Returns null when none exists. */
export async function readGuide(
  storage: BlobStorage,
  id: string,
): Promise<GuideReadResult | null> {
  const result = await downloadBlob(storage, guideBlobPath(id));
  if (result === null) return null;
  const parsed = GuideSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Malformed guide blob for id ${id}: ${parsed.error.message}`,
    );
  }
  return { guide: parsed.data, etag: result.etag };
}

/**
 * Compare-and-swap guide write. The blob path is derived from the record's
 * own id, so a guide can never land at another id's path.
 * `ifMatchEtag` set → update (`If-Match`); null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}.
 * Returns the new ETag.
 */
export async function writeGuide(
  storage: BlobStorage,
  guide: Guide,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = GuideSchema.parse(guide);
  return uploadJson(
    storage,
    guideBlobPath(parsed.id),
    parsed,
    ifMatchEtag,
    'agentAccess.writeGuide',
  );
}

/**
 * Conditional guide delete (`If-Match`). Returns false when the blob was
 * already absent (idempotent); 412 → {@link AgentAccessConflictError}.
 */
export async function deleteGuide(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  const client = storage.getBlockBlobClient(guideBlobPath(id));
  try {
    await withAzureRetry(
      () => client.delete({ conditions: { ifMatch: ifMatchEtag } }),
      { label: 'agentAccess.deleteGuide' },
    );
    return true;
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 404) return false;
    if (status === 412) throw new AgentAccessConflictError();
    throw error;
  }
}

/**
 * Appends an immutable guide history entry (`If-None-Match: *`) at
 * `historyBlobPath(canonicalKey)` — same audit namespace as rules. A 412
 * means an earlier attempt (or a retry) already landed this exact entry —
 * treated as idempotent success. Callers wrap this best-effort: a history
 * failure must never fail the mutation (mirror appendHistoryBestEffort).
 */
export async function writeGuideHistoryEntry(
  storage: BlobStorage,
  entry: GuideHistoryEntry,
): Promise<void> {
  const parsed = GuideHistoryEntrySchema.parse(entry);
  const client = storage.getBlockBlobClient(
    historyBlobPath(parsed.canonicalKey, parsed.updatedAt),
  );
  const content = Buffer.from(JSON.stringify(parsed), 'utf8');
  try {
    await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'agentAccess.writeGuideHistoryEntry' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 412) return;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Map datasets (split meta/data blobs)                                */
/* ------------------------------------------------------------------ */

/**
 * Unconditional JSON upload for DERIVED blobs (dataset meta). The CAS
 * discipline lives on the data blob; the meta is a projection of it and is
 * simply overwritten after every successful data write.
 */
async function uploadJsonUnconditional(
  storage: BlobStorage,
  blobPath: string,
  payload: unknown,
  label: string,
): Promise<void> {
  const client = storage.getBlockBlobClient(blobPath);
  const content = Buffer.from(JSON.stringify(payload), 'utf8');
  await withAzureRetry(
    () =>
      client.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      }),
    { label },
  );
}

/**
 * Lists dataset META blobs only — the ~1MB data blobs are never touched by
 * listings (that is the point of the split). Malformed metas are SKIPPED
 * with a loud log (same soft-skip rationale as listAllPromptAgents); a
 * skipped dataset fails SAFE — it disappears from listings and its load
 * endpoint still serves the truthful data blob to those who know the id
 * (subject to the fail-closed rules, which live elsewhere).
 */
export async function listAllMapDatasetMetas(
  storage: BlobStorage,
): Promise<StoredMapDatasetMeta[]> {
  const names = await storage.listBlobs(AGENT_ACCESS_MAP_DATASET_META_PREFIX);
  const results = await Promise.all(
    names.map(async (name): Promise<StoredMapDatasetMeta | null> => {
      // 404 → deleted between list and get; skip silently.
      const downloaded = await downloadBlob(storage, name);
      if (downloaded === null) return null;

      let json: unknown;
      try {
        json = JSON.parse(downloaded.buffer.toString('utf8'));
      } catch {
        console.error(
          `[agent-access] SKIPPING map-dataset meta blob with invalid JSON (broken dataset degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      const parsed = MapDatasetMetaSchema.safeParse(json);
      if (!parsed.success) {
        console.error(
          `[agent-access] SKIPPING malformed map-dataset meta blob (broken dataset degrades alone; rules snapshot unaffected) ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
        );
        return null;
      }
      if (mapDatasetMetaBlobPath(parsed.data.id) !== name) {
        // A stray blob must not shadow (or masquerade as) another id's
        // dataset in listings.
        console.error(
          `[agent-access] SKIPPING map-dataset meta blob whose name does not match its content's id (broken dataset degrades alone; rules snapshot unaffected): ${sanitizeForLog(name)}`,
        );
        return null;
      }
      return {
        canonicalKey: canonicalAgentKey(MAP_DATASET_SOURCE, parsed.data.id),
        blobPath: name,
        meta: parsed.data,
      };
    }),
  );
  return results.filter((r): r is StoredMapDatasetMeta => r !== null);
}

/** Reads one dataset META. Returns null when none exists. */
export async function readMapDatasetMeta(
  storage: BlobStorage,
  id: string,
): Promise<MapDatasetMeta | null> {
  const result = await downloadBlob(storage, mapDatasetMetaBlobPath(id));
  if (result === null) return null;
  const parsed = MapDatasetMetaSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Malformed map-dataset meta blob for id ${id}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Reads one dataset's full DATA blob. Returns null when none exists. The
 * returned etag is the data blob's — the If-Match token for every write.
 */
export async function readMapDataset(
  storage: BlobStorage,
  id: string,
): Promise<MapDatasetReadResult | null> {
  const result = await downloadBlob(storage, mapDatasetDataBlobPath(id));
  if (result === null) return null;
  const parsed = MapDatasetSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Malformed map-dataset data blob for id ${id}: ${parsed.error.message}`,
    );
  }
  return { dataset: parsed.data, etag: result.etag };
}

/**
 * Compare-and-swap dataset write: the DATA blob is written under the CAS
 * condition (`ifMatchEtag` set → update; null → creation only; 412 →
 * {@link AgentAccessConflictError}), then the derived META is rewritten
 * UNCONDITIONALLY. A meta failure is logged loudly but never thrown — the
 * data write already landed, listings go stale-not-wrong, and the next
 * successful save repairs the meta. Returns the new data ETag.
 */
export async function writeMapDataset(
  storage: BlobStorage,
  dataset: MapDataset,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = MapDatasetSchema.parse(dataset);
  const etag = await uploadJson(
    storage,
    mapDatasetDataBlobPath(parsed.id),
    parsed,
    ifMatchEtag,
    'agentAccess.writeMapDatasetData',
  );
  try {
    await uploadJsonUnconditional(
      storage,
      mapDatasetMetaBlobPath(parsed.id),
      mapDatasetMeta(parsed),
      'agentAccess.writeMapDatasetMeta',
    );
  } catch (error) {
    console.error(
      `[agent-access] map-dataset META write failed for id=${sanitizeForLog(parsed.id)} (listing will be stale until the next save; the data blob is current): ${sanitizeForLog(error)}`,
    );
  }
  return etag;
}

/**
 * Conditional dataset delete: DATA blob under If-Match first (412 →
 * {@link AgentAccessConflictError}), then META best-effort. Returns false
 * when the data blob was already absent — but the META delete still runs so
 * a re-issued DELETE cleans up an orphaned listing entry (self-healing).
 */
export async function deleteMapDataset(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  let dataDeleted = true;
  const dataClient = storage.getBlockBlobClient(mapDatasetDataBlobPath(id));
  try {
    await withAzureRetry(
      () => dataClient.delete({ conditions: { ifMatch: ifMatchEtag } }),
      { label: 'agentAccess.deleteMapDatasetData' },
    );
  } catch (error) {
    const status = statusCodeOf(error);
    if (status === 412) throw new AgentAccessConflictError();
    if (status !== 404) throw error;
    dataDeleted = false;
  }
  const metaClient = storage.getBlockBlobClient(mapDatasetMetaBlobPath(id));
  try {
    await withAzureRetry(() => metaClient.delete(), {
      label: 'agentAccess.deleteMapDatasetMeta',
    });
  } catch (error) {
    if (statusCodeOf(error) !== 404) {
      console.error(
        `[agent-access] map-dataset META delete failed for id=${sanitizeForLog(id)} (orphaned listing entry; re-run the delete to clean it): ${sanitizeForLog(error)}`,
      );
    }
  }
  return dataDeleted;
}

/**
 * Appends an immutable dataset history entry (`If-None-Match: *`) at
 * `historyBlobPath(canonicalKey)`. Carries META only (see the schema
 * comment). 412 = an earlier attempt already landed this entry — idempotent
 * success. Callers wrap best-effort.
 */
export async function writeMapDatasetHistoryEntry(
  storage: BlobStorage,
  entry: MapDatasetHistoryEntry,
): Promise<void> {
  const parsed = MapDatasetHistoryEntrySchema.parse(entry);
  const client = storage.getBlockBlobClient(
    historyBlobPath(parsed.canonicalKey, parsed.updatedAt),
  );
  const content = Buffer.from(JSON.stringify(parsed), 'utf8');
  try {
    await withAzureRetry(
      () =>
        client.upload(content, content.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: { ifNoneMatch: '*' },
        }),
      { label: 'agentAccess.writeMapDatasetHistoryEntry' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 412) return;
    throw error;
  }
}
