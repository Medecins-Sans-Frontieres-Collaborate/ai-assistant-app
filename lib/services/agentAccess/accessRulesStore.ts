import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  statusCodeOf,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { defineBlobEntity } from '@/lib/services/agentAccess/blobEntityStore';
import {
  AGENT_ACCESS_CATALOG_OAUTH_PREFIX,
  AGENT_ACCESS_CONFIG_PATH,
  AGENT_ACCESS_CONNECTORS_PREFIX,
  AGENT_ACCESS_GENERATION_PATH,
  AGENT_ACCESS_GUIDES_PREFIX,
  AGENT_ACCESS_M365_AGENTS_PREFIX,
  AGENT_ACCESS_MAP_DATASET_META_PREFIX,
  AGENT_ACCESS_ORG_AGENTS_PREFIX,
  AGENT_ACCESS_PROMPT_AGENTS_PREFIX,
  AGENT_ACCESS_RULES_PREFIX,
  AgentAccessConfig,
  AgentAccessConfigSchema,
  AgentAccessHistoryEntry,
  AgentAccessHistoryEntrySchema,
  AgentAccessRule,
  AgentAccessRuleSchema,
  CATALOG_OAUTH_SOURCE,
  CatalogOauthApp,
  CatalogOauthAppHistoryEntry,
  CatalogOauthAppHistoryEntrySchema,
  CatalogOauthAppSchema,
  GUIDE_SOURCE,
  Guide,
  GuideHistoryEntry,
  GuideHistoryEntrySchema,
  GuideSchema,
  HistoryEntryEnvelope,
  HistoryEntryEnvelopeSchema,
  M365Agent,
  M365AgentHistoryEntry,
  M365AgentHistoryEntrySchema,
  M365AgentSchema,
  M365_AGENT_SOURCE,
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
  ORG_AGENT_SOURCE,
  OrgRagAgent,
  OrgRagAgentHistoryEntry,
  OrgRagAgentHistoryEntrySchema,
  OrgRagAgentSchema,
  PROMPT_AGENT_SOURCE,
  PromptAgent,
  PromptAgentHistoryEntry,
  PromptAgentHistoryEntrySchema,
  PromptAgentSchema,
  canonicalAgentKey,
  catalogOauthBlobPath,
  connectorBlobPath,
  guideBlobPath,
  historyBlobPath,
  historyListPrefix,
  m365AgentBlobPath,
  mapDatasetDataBlobPath,
  mapDatasetMeta,
  mapDatasetMetaBlobPath,
  orgAgentBlobPath,
  promptAgentBlobPath,
  ruleBlobPath,
} from '@/lib/services/agentAccess/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/**
 * Blob persistence for agent access rules, config, and history.
 *
 * The compare-and-swap primitives themselves (`downloadBlob`, `uploadJson`,
 * `AgentAccessConflictError`, and why `AzureBlobStorage.upload()` must never
 * be used for them) live in `./blobCas` — see that module's header for the
 * full CAS discipline. They are shared with the usage-limits store.
 * `AgentAccessConflictError` is re-exported here so existing importers of
 * this module are unaffected.
 *
 * Three tiers of entity live here:
 *
 * 1. RULES + CONFIG — bespoke, below. The rules listing is FAIL-CLOSED
 *    (see {@link listAllRules}) and rule blob paths derive from a
 *    content-hash of the canonical key, both of which the generic factory
 *    deliberately does not model.
 * 2. The five UNIFORM entities (prompt agents, M365 agents, org RAG
 *    agents, MCP connectors, guides) — built from
 *    {@link defineBlobEntity} (./blobEntityStore.ts), which owns the
 *    shared soft-skip/CAS/history semantics. The per-entity functions
 *    below are thin wrappers preserving the historical names and result
 *    field names, so callers and tests are unchanged.
 * 3. MAP DATASETS — bespoke split meta/data blobs at the bottom (listings
 *    read the ~1KB meta; loads read the ~1MB data).
 */
export { AgentAccessConflictError };

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

export interface StoredM365Agent {
  /** `m365-agent::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  m365Agent: M365Agent;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface M365AgentReadResult {
  m365Agent: M365Agent;
  etag: string;
}

export interface StoredOrgRagAgent {
  /** `org-agent::<id>` — flows through delegation and rules unchanged. */
  canonicalKey: string;
  blobPath: string;
  orgAgent: OrgRagAgent;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface OrgRagAgentReadResult {
  orgAgent: OrgRagAgent;
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

export interface StoredCatalogOauthApp {
  /** `catalog-oauth::<catalogKey>`. */
  canonicalKey: string;
  blobPath: string;
  app: CatalogOauthApp;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

export interface CatalogOauthAppReadResult {
  app: CatalogOauthApp;
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
 * Rules live in the centralized ADMIN storage (EU account, dedicated
 * lifecycle-free container) shared by every admin/system store — see
 * lib/services/adminBlobStorage.ts for the residency/centralization/
 * lifecycle rationale. The name is kept for its many import sites.
 */
export function createAgentAccessBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
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
 *
 * This inversion of the soft-skip trade-off is why rules are NOT built from
 * defineBlobEntity (./blobEntityStore.ts) like the sibling entities.
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
 * Cross-replica invalidation sentinel. A tiny blob bumped UNCONDITIONALLY
 * (fire-and-forget, best-effort) after every successful admin write;
 * replicas probe its ETag between full refreshes and refetch immediately
 * when it changed. The sentinel only ACCELERATES propagation — the snapshot
 * TTL remains the correctness backstop, so a failed bump costs latency
 * (≤TTL, exactly today's bound), never correctness.
 */
export async function readGenerationEtag(
  storage: BlobStorage,
): Promise<string | null> {
  const result = await downloadBlob(storage, AGENT_ACCESS_GENERATION_PATH);
  return result?.etag ?? null;
}

export async function bumpGeneration(storage: BlobStorage): Promise<void> {
  const client = storage.getBlockBlobClient(AGENT_ACCESS_GENERATION_PATH);
  const content = Buffer.from(
    JSON.stringify({ bumpedAt: new Date().toISOString() }),
    'utf8',
  );
  await withAzureRetry(
    () =>
      client.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      }),
    { label: 'agentAccess.bumpGeneration' },
  );
}

export interface StoredHistoryEntry {
  blobPath: string;
  entry: HistoryEntryEnvelope;
}

/**
 * Lists one canonical key's immutable history entries, NEWEST FIRST.
 * Entity-agnostic: entries are validated against the shared envelope
 * (canonicalKey/action/updatedBy/updatedAt) and the per-entity payload
 * passes through verbatim for the admin history viewer / restore flow.
 * Malformed blobs are SKIPPED with a loud log — history is an audit
 * convenience, and one corrupt entry must not hide the rest. An entry
 * whose embedded canonicalKey does not hash to this listing's prefix is
 * skipped too (hand-placed blobs must not masquerade as another key's
 * audit trail).
 */
export async function listHistoryEntries(
  storage: BlobStorage,
  canonicalKey: string,
): Promise<StoredHistoryEntry[]> {
  const names = await storage.listBlobs(historyListPrefix(canonicalKey));
  const results = await Promise.all(
    names.map(async (name): Promise<StoredHistoryEntry | null> => {
      // 404 → deleted between list and get; skip silently.
      const downloaded = await downloadBlob(storage, name);
      if (downloaded === null) return null;

      let json: unknown;
      try {
        json = JSON.parse(downloaded.buffer.toString('utf8'));
      } catch {
        console.error(
          `[agent-access] SKIPPING history blob with invalid JSON: ${sanitizeForLog(name)}`,
        );
        return null;
      }
      const parsed = HistoryEntryEnvelopeSchema.safeParse(json);
      if (!parsed.success) {
        console.error(
          `[agent-access] SKIPPING malformed history blob ${sanitizeForLog(name)}: ${sanitizeForLog(parsed.error.message)}`,
        );
        return null;
      }
      if (parsed.data.canonicalKey !== canonicalKey) {
        console.error(
          `[agent-access] SKIPPING history blob whose content's canonicalKey does not match the listing key: ${sanitizeForLog(name)}`,
        );
        return null;
      }
      return { blobPath: name, entry: parsed.data };
    }),
  );
  return results
    .filter((r): r is StoredHistoryEntry => r !== null)
    .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
}

/* ------------------------------------------------------------------ */
/* Uniform entities (defineBlobEntity — see ./blobEntityStore.ts for   */
/* the shared soft-skip / CAS / history semantics)                     */
/* ------------------------------------------------------------------ */

const promptAgentEntity = defineBlobEntity<
  PromptAgent,
  PromptAgentHistoryEntry
>({
  logNoun: 'prompt-agent',
  errorNoun: 'prompt agent',
  source: PROMPT_AGENT_SOURCE,
  listPrefix: AGENT_ACCESS_PROMPT_AGENTS_PREFIX,
  blobPath: promptAgentBlobPath,
  schema: PromptAgentSchema,
  historySchema: PromptAgentHistoryEntrySchema,
  labelBase: 'PromptAgent',
});

const m365AgentEntity = defineBlobEntity<M365Agent, M365AgentHistoryEntry>({
  logNoun: 'm365-agent',
  errorNoun: 'm365 agent',
  source: M365_AGENT_SOURCE,
  listPrefix: AGENT_ACCESS_M365_AGENTS_PREFIX,
  blobPath: m365AgentBlobPath,
  schema: M365AgentSchema,
  historySchema: M365AgentHistoryEntrySchema,
  labelBase: 'M365Agent',
});

const orgAgentEntity = defineBlobEntity<OrgRagAgent, OrgRagAgentHistoryEntry>({
  logNoun: 'org-agent',
  errorNoun: 'org agent',
  source: ORG_AGENT_SOURCE,
  listPrefix: AGENT_ACCESS_ORG_AGENTS_PREFIX,
  blobPath: orgAgentBlobPath,
  schema: OrgRagAgentSchema,
  historySchema: OrgRagAgentHistoryEntrySchema,
  labelBase: 'OrgAgent',
});

const connectorEntity = defineBlobEntity<
  McpConnector,
  McpConnectorHistoryEntry
>({
  logNoun: 'connector',
  errorNoun: 'connector',
  source: MCP_CONNECTOR_SOURCE,
  listPrefix: AGENT_ACCESS_CONNECTORS_PREFIX,
  blobPath: connectorBlobPath,
  schema: McpConnectorSchema,
  historySchema: McpConnectorHistoryEntrySchema,
  labelBase: 'Connector',
});

const catalogOauthEntity = defineBlobEntity<
  CatalogOauthApp,
  CatalogOauthAppHistoryEntry
>({
  logNoun: 'catalog-oauth-app',
  errorNoun: 'catalog OAuth app',
  source: CATALOG_OAUTH_SOURCE,
  listPrefix: AGENT_ACCESS_CATALOG_OAUTH_PREFIX,
  blobPath: catalogOauthBlobPath,
  schema: CatalogOauthAppSchema,
  historySchema: CatalogOauthAppHistoryEntrySchema,
  labelBase: 'CatalogOauthApp',
});

const guideEntity = defineBlobEntity<Guide, GuideHistoryEntry>({
  logNoun: 'guide',
  errorNoun: 'guide',
  source: GUIDE_SOURCE,
  listPrefix: AGENT_ACCESS_GUIDES_PREFIX,
  blobPath: guideBlobPath,
  schema: GuideSchema,
  historySchema: GuideHistoryEntrySchema,
  labelBase: 'Guide',
});

/* --- Prompt agents ------------------------------------------------- */

export async function listAllPromptAgents(
  storage: BlobStorage,
): Promise<StoredPromptAgent[]> {
  const entries = await promptAgentEntity.listAll(storage);
  return entries.map(({ canonicalKey, blobPath, record, etag }) => ({
    canonicalKey,
    blobPath,
    agent: record,
    etag,
  }));
}

/** Reads a single prompt agent by id. Returns null when none exists. */
export async function readPromptAgent(
  storage: BlobStorage,
  id: string,
): Promise<PromptAgentReadResult | null> {
  const result = await promptAgentEntity.read(storage, id);
  return result && { agent: result.record, etag: result.etag };
}

export function writePromptAgent(
  storage: BlobStorage,
  agent: PromptAgent,
  ifMatchEtag: string | null,
): Promise<string> {
  return promptAgentEntity.write(storage, agent, ifMatchEtag);
}

export function deletePromptAgent(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  return promptAgentEntity.remove(storage, id, ifMatchEtag);
}

export function writePromptAgentHistoryEntry(
  storage: BlobStorage,
  entry: PromptAgentHistoryEntry,
): Promise<void> {
  return promptAgentEntity.writeHistory(storage, entry);
}

/* --- M365 file-backed agents --------------------------------------- */

export async function listAllM365Agents(
  storage: BlobStorage,
): Promise<StoredM365Agent[]> {
  const entries = await m365AgentEntity.listAll(storage);
  return entries.map(({ canonicalKey, blobPath, record, etag }) => ({
    canonicalKey,
    blobPath,
    m365Agent: record,
    etag,
  }));
}

/** Reads a single M365 agent by id. Returns null when none exists. */
export async function readM365Agent(
  storage: BlobStorage,
  id: string,
): Promise<M365AgentReadResult | null> {
  const result = await m365AgentEntity.read(storage, id);
  return result && { m365Agent: result.record, etag: result.etag };
}

export function writeM365Agent(
  storage: BlobStorage,
  agent: M365Agent,
  ifMatchEtag: string | null,
): Promise<string> {
  return m365AgentEntity.write(storage, agent, ifMatchEtag);
}

export function deleteM365Agent(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  return m365AgentEntity.remove(storage, id, ifMatchEtag);
}

export function writeM365AgentHistoryEntry(
  storage: BlobStorage,
  entry: M365AgentHistoryEntry,
): Promise<void> {
  return m365AgentEntity.writeHistory(storage, entry);
}

/* --- Org RAG agents ------------------------------------------------- */

export async function listAllOrgAgents(
  storage: BlobStorage,
): Promise<StoredOrgRagAgent[]> {
  const entries = await orgAgentEntity.listAll(storage);
  return entries.map(({ canonicalKey, blobPath, record, etag }) => ({
    canonicalKey,
    blobPath,
    orgAgent: record,
    etag,
  }));
}

/** Reads a single org RAG agent by id. Returns null when none exists. */
export async function readOrgAgent(
  storage: BlobStorage,
  id: string,
): Promise<OrgRagAgentReadResult | null> {
  const result = await orgAgentEntity.read(storage, id);
  return result && { orgAgent: result.record, etag: result.etag };
}

export function writeOrgAgent(
  storage: BlobStorage,
  agent: OrgRagAgent,
  ifMatchEtag: string | null,
): Promise<string> {
  return orgAgentEntity.write(storage, agent, ifMatchEtag);
}

export function deleteOrgAgent(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  return orgAgentEntity.remove(storage, id, ifMatchEtag);
}

export function writeOrgAgentHistoryEntry(
  storage: BlobStorage,
  entry: OrgRagAgentHistoryEntry,
): Promise<void> {
  return orgAgentEntity.writeHistory(storage, entry);
}

/* --- MCP connectors ------------------------------------------------- */

export async function listAllConnectors(
  storage: BlobStorage,
): Promise<StoredMcpConnector[]> {
  const entries = await connectorEntity.listAll(storage);
  return entries.map(({ canonicalKey, blobPath, record, etag }) => ({
    canonicalKey,
    blobPath,
    connector: record,
    etag,
  }));
}

/** Reads a single connector by id. Returns null when none exists. */
export async function readConnector(
  storage: BlobStorage,
  id: string,
): Promise<McpConnectorReadResult | null> {
  const result = await connectorEntity.read(storage, id);
  return result && { connector: result.record, etag: result.etag };
}

/**
 * Compare-and-swap connector write. Deriving the path from the record's own
 * id also keeps the sealed client secret's AAD binding meaningful. The
 * history entry carries the connector verbatim INCLUDING its sealed secret —
 * sealed, so the audit trail never holds plaintext.
 */
export function writeConnector(
  storage: BlobStorage,
  connector: McpConnector,
  ifMatchEtag: string | null,
): Promise<string> {
  return connectorEntity.write(storage, connector, ifMatchEtag);
}

export function deleteConnector(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  return connectorEntity.remove(storage, id, ifMatchEtag);
}

export function writeConnectorHistoryEntry(
  storage: BlobStorage,
  entry: McpConnectorHistoryEntry,
): Promise<void> {
  return connectorEntity.writeHistory(storage, entry);
}

/* --- Catalog OAuth apps --------------------------------------------- */

export async function listAllCatalogOauthApps(
  storage: BlobStorage,
): Promise<StoredCatalogOauthApp[]> {
  const entries = await catalogOauthEntity.listAll(storage);
  return entries.map(({ canonicalKey, blobPath, record, etag }) => ({
    canonicalKey,
    blobPath,
    app: record,
    etag,
  }));
}

/** Reads one catalog OAuth app by catalog key. Null when none exists. */
export async function readCatalogOauthApp(
  storage: BlobStorage,
  catalogKey: string,
): Promise<CatalogOauthAppReadResult | null> {
  const result = await catalogOauthEntity.read(storage, catalogKey);
  return result && { app: result.record, etag: result.etag };
}

/**
 * Compare-and-swap catalog OAuth app write. The record id (= catalog key)
 * derives both the blob path and the sealed secret's AAD binding, and the
 * history entry carries the record verbatim INCLUDING its sealed secret —
 * sealed, so the audit trail never holds plaintext.
 */
export function writeCatalogOauthApp(
  storage: BlobStorage,
  app: CatalogOauthApp,
  ifMatchEtag: string | null,
): Promise<string> {
  return catalogOauthEntity.write(storage, app, ifMatchEtag);
}

export function deleteCatalogOauthApp(
  storage: BlobStorage,
  catalogKey: string,
  ifMatchEtag: string,
): Promise<boolean> {
  return catalogOauthEntity.remove(storage, catalogKey, ifMatchEtag);
}

export function writeCatalogOauthAppHistoryEntry(
  storage: BlobStorage,
  entry: CatalogOauthAppHistoryEntry,
): Promise<void> {
  return catalogOauthEntity.writeHistory(storage, entry);
}

/* --- Workflow guides ------------------------------------------------ */

export async function listAllGuides(
  storage: BlobStorage,
): Promise<StoredGuide[]> {
  const entries = await guideEntity.listAll(storage);
  return entries.map(({ canonicalKey, blobPath, record, etag }) => ({
    canonicalKey,
    blobPath,
    guide: record,
    etag,
  }));
}

/** Reads a single guide by id. Returns null when none exists. */
export async function readGuide(
  storage: BlobStorage,
  id: string,
): Promise<GuideReadResult | null> {
  const result = await guideEntity.read(storage, id);
  return result && { guide: result.record, etag: result.etag };
}

export function writeGuide(
  storage: BlobStorage,
  guide: Guide,
  ifMatchEtag: string | null,
): Promise<string> {
  return guideEntity.write(storage, guide, ifMatchEtag);
}

export function deleteGuide(
  storage: BlobStorage,
  id: string,
  ifMatchEtag: string,
): Promise<boolean> {
  return guideEntity.remove(storage, id, ifMatchEtag);
}

export function writeGuideHistoryEntry(
  storage: BlobStorage,
  entry: GuideHistoryEntry,
): Promise<void> {
  return guideEntity.writeHistory(storage, entry);
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
 * with a loud log (same soft-skip rationale as the uniform entities); a
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
