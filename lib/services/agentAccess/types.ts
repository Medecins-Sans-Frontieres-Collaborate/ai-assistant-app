/**
 * App-layer agent access control — schemas, canonical keys, blob paths.
 *
 * See docs/AGENT_ACCESS_CONTROL.md. Rules only ever further restrict what a
 * user's own Azure RBAC already allows; they can never grant access Azure
 * denies. All blobs live under a reserved `system/` prefix that cannot
 * collide with user upload paths (`<userId-guid>/uploads/...`).
 */
import Hasher from '@/lib/utils/app/hash';

import { z } from 'zod';

export const AGENT_ACCESS_PREFIX = 'system/agent-access/';
export const AGENT_ACCESS_RULES_PREFIX = `${AGENT_ACCESS_PREFIX}rules/`;
export const AGENT_ACCESS_HISTORY_PREFIX = `${AGENT_ACCESS_PREFIX}history/`;
export const AGENT_ACCESS_CONFIG_PATH = `${AGENT_ACCESS_PREFIX}config.json`;
/** Cross-replica invalidation sentinel — see bumpGeneration in the store. */
export const AGENT_ACCESS_GENERATION_PATH = `${AGENT_ACCESS_PREFIX}generation.json`;
export const AGENT_ACCESS_PROMPT_AGENTS_PREFIX = `${AGENT_ACCESS_PREFIX}prompt-agents/`;
export const AGENT_ACCESS_CONNECTORS_PREFIX = `${AGENT_ACCESS_PREFIX}connectors/`;
export const AGENT_ACCESS_GUIDES_PREFIX = `${AGENT_ACCESS_PREFIX}guides/`;
export const AGENT_ACCESS_CATALOG_OAUTH_PREFIX = `${AGENT_ACCESS_PREFIX}catalog-oauth/`;
export const AGENT_ACCESS_MAP_DATASET_META_PREFIX = `${AGENT_ACCESS_PREFIX}map-datasets/meta/`;
export const AGENT_ACCESS_MAP_DATASET_DATA_PREFIX = `${AGENT_ACCESS_PREFIX}map-datasets/data/`;
export const AGENT_ACCESS_M365_AGENTS_PREFIX = `${AGENT_ACCESS_PREFIX}m365-agents/`;
/**
 * Per-agent source manifests (docs/M365_SEVENTH_PASS_RECURSIVE_AGENT_SOURCES.md)
 * live OUTSIDE the agents prefix: listAllM365Agents rejects (loudly) any blob
 * under m365-agents/ whose name isn't `<id>.json`.
 */
export const AGENT_ACCESS_M365_MANIFESTS_PREFIX = `${AGENT_ACCESS_PREFIX}m365-agent-manifests/`;
export const AGENT_ACCESS_ORG_AGENTS_PREFIX = `${AGENT_ACCESS_PREFIX}org-agents/`;

/**
 * Pseudo-source for app-defined prompt agents in canonical keys
 * (`prompt-agent::<id>`). Lowercase-stable, and cannot collide with real ARM
 * resource paths (those always start with '/').
 */
export const PROMPT_AGENT_SOURCE = 'prompt-agent';

/**
 * Pseudo-source for admin-authored MCP connectors in canonical keys
 * (`mcp-connector::<id>`). Same rationale as PROMPT_AGENT_SOURCE: reusing the
 * canonical-key namespace means connectors get the existing rule matching,
 * local-admin delegation, and history machinery for free.
 */
export const MCP_CONNECTOR_SOURCE = 'mcp-connector';

/**
 * Pseudo-source for admin-authored workflow guides in canonical keys
 * (`guide::<id>`). Same rationale as PROMPT_AGENT_SOURCE: reusing the
 * canonical-key namespace means guides get the existing rule matching,
 * local-admin delegation, and history machinery for free.
 */
export const GUIDE_SOURCE = 'guide';

/**
 * Pseudo-source for admin-configured CATALOG OAuth apps in canonical keys
 * (`catalog-oauth::<catalogKey>`). These records carry the deployment's
 * OAuth client id/secret for a curated catalog connector (github, asana, …)
 * so admins can configure them in Admin → Connectors instead of env vars.
 */
export const CATALOG_OAUTH_SOURCE = 'catalog-oauth';

/**
 * Pseudo-source for admin-curated map datasets in canonical keys
 * (`map-dataset::<id>`). Same rationale as PROMPT_AGENT_SOURCE: reusing the
 * canonical-key namespace means datasets get the existing rule matching,
 * local-admin delegation, and history machinery for free.
 */
export const MAP_DATASET_SOURCE = 'map-dataset';

/**
 * Pseudo-source for M365 file-backed RAG agents in canonical keys
 * (`m365-agent::<id>`). Same rationale as PROMPT_AGENT_SOURCE: reusing the
 * canonical-key namespace means these agents get the existing rule matching,
 * local-admin delegation, and history machinery for free.
 */
export const M365_AGENT_SOURCE = 'm365-agent';

/**
 * Pseudo-source for admin-authored organization RAG agents in canonical keys
 * (`org-agent::<id>`). Same rationale as PROMPT_AGENT_SOURCE: reusing the
 * canonical-key namespace means these agents get the existing rule matching,
 * local-admin delegation, and history machinery for free.
 */
export const ORG_AGENT_SOURCE = 'org-agent';

export const AgentAccessTypeSchema = z.enum(['public', 'restricted']);
export type AgentAccessType = z.infer<typeof AgentAccessTypeSchema>;

export const AgentAccessRuleSchema = z.object({
  version: z.literal(1),
  /** Original casing preserved for display; matching uses canonicalAgentKey. */
  source: z.string().min(1),
  agentName: z.string().min(1),
  access: z.object({
    type: AgentAccessTypeSchema,
    /** Matched against the part after '@' in session.user.mail (lowercased). */
    allowDomains: z.array(z.string()).default([]),
    /** Matched lowercased against session.user.mail. */
    allowUsers: z.array(z.string()).default([]),
    /** SCAFFOLD ONLY — persisted but never evaluated in v1 (pending tenant consent). */
    allowGroups: z.array(z.string()).default([]),
  }),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AgentAccessRule = z.infer<typeof AgentAccessRuleSchema>;

export const LocalAdminEntrySchema = z.object({
  /** Graph `mail` value; matched lowercased + trimmed. */
  email: z.string().min(1),
  /** Canonical agent keys this local admin may create/edit/delete rules for. */
  agentKeys: z.array(z.string()).default([]),
});
export type LocalAdminEntry = z.infer<typeof LocalAdminEntrySchema>;

export const AgentAccessConfigSchema = z.object({
  version: z.literal(1),
  localAdmins: z.array(LocalAdminEntrySchema).default([]),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AgentAccessConfig = z.infer<typeof AgentAccessConfigSchema>;

/**
 * Immutable audit copy written alongside every successful rule write
 * (including deletes, which record a null-rule tombstone).
 */
export const AgentAccessHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full rule as written, or null for a delete tombstone. */
  rule: AgentAccessRuleSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AgentAccessHistoryEntry = z.infer<
  typeof AgentAccessHistoryEntrySchema
>;

/**
 * App-defined persona (display name + system prompt + model id) served
 * through /api/agents and invoked on the standard chat path. Read-side
 * permissive per the schema-evolution rule: new fields must be
 * optional/defaulted so previously-stored blobs keep parsing.
 */
export const PromptAgentSchema = z.object({
  version: z.literal(1),
  /** Server-generated `prompt-<hex>`; immutable — canonical keys hang off it. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  systemPrompt: z.string().min(1),
  modelId: z.string().min(1),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type PromptAgent = z.infer<typeof PromptAgentSchema>;

/**
 * Immutable audit copy written alongside every successful prompt-agent write
 * (including deletes, which record a null-promptAgent tombstone).
 */
export const PromptAgentHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full record as written, or null for a delete tombstone. */
  promptAgent: PromptAgentSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type PromptAgentHistoryEntry = z.infer<
  typeof PromptAgentHistoryEntrySchema
>;

/** Per-tier counts from the last plan/index run of a source. */
export const M365SourceCountsSchema = z.object({
  indexable: z.number().default(0),
  needsPreparation: z.number().default(0),
  skipped: z.number().default(0),
  /** Bytes of the indexable files (early budget signal). */
  bytes: z.number().default(0),
  indexed: z.number().optional(),
  failed: z.number().optional(),
  noText: z.number().optional(),
  missing: z.number().optional(),
});
export type M365SourceCounts = z.infer<typeof M365SourceCountsSchema>;

/**
 * One OneDrive/SharePoint source backing an M365 agent. Read-side permissive
 * per the schema-evolution rule.
 */
export const M365AgentSourceSchema = z.object({
  /** Stable app-side id (`src-<hex>`); survives re-indexing. */
  sourceId: z.string().min(1),
  driveId: z.string().min(1),
  itemId: z.string().min(1),
  kind: z.enum(['file', 'folder']).default('file'),
  title: z.string().min(1),
  /** Doubles as the request-access link for users who can't open the file. */
  webUrl: z.string().default(''),
  /** Shown in the "ask for access" hint. */
  ownerDisplay: z.string().optional(),
  status: z
    .enum(['pending', 'indexing', 'indexed', 'error', 'missing'])
    .default('pending'),
  lastIndexedAt: z.string().optional(),
  /** Chunks currently in the search index for this source. */
  indexedChunks: z.number().optional(),
  error: z.string().optional(),
  /**
   * Folder sources only: include the whole subtree (seventh pass). Records
   * written before recursion existed default to the old immediate-children
   * snapshot semantics until an admin re-saves them; the editor defaults
   * NEW folders to true.
   */
  recursive: z.boolean().default(false),
  /**
   * Graph item ids (subfolders or files) the admin unchecked in the plan
   * view. Excluding a folder excludes its subtree.
   */
  excludedItemIds: z.array(z.string()).default([]),
  /**
   * Lowercase extensions without the dot; when set, only matching files are
   * indexed (others are reported as skipped by the type filter).
   */
  includeExtensions: z.array(z.string()).optional(),
  /** Aggregate of the last plan/index run, for the admin list and editor. */
  counts: M365SourceCountsSchema.optional(),
});
export type M365AgentSource = z.infer<typeof M365AgentSourceSchema>;

/**
 * Per-document classification made by the planner BEFORE any download
 * (docs/M365_SEVENTH_PASS_RECURSIVE_AGENT_SOURCES.md §3). `indexable` files
 * are processed by the index run; `needsPreparation` files (images,
 * audio/video) wait for an explicit per-file preparation step; `skipped`
 * files carry the reason and never count toward the cap.
 */
export const M365ManifestTierSchema = z.enum([
  'indexable',
  'needsPreparation',
  'skipped',
]);
export type M365ManifestTier = z.infer<typeof M365ManifestTierSchema>;

export const M365ManifestSkipReasonSchema = z.enum([
  'unsupported',
  'tooLarge',
  'disallowedType',
  'malware',
  'zeroBytes',
  'excluded',
  'typeFilter',
]);
export type M365ManifestSkipReason = z.infer<
  typeof M365ManifestSkipReasonSchema
>;

/** Outcome of the index run for one manifest item. */
export const M365ManifestItemStatusSchema = z.enum([
  'pending',
  'indexed',
  'failed',
  'noText',
  'missing',
]);
export type M365ManifestItemStatus = z.infer<
  typeof M365ManifestItemStatusSchema
>;

export const M365ManifestItemSchema = z.object({
  itemId: z.string().min(1),
  driveId: z.string().min(1),
  name: z.string(),
  /** Folder path relative to the source folder ("" at the source root). */
  path: z.string().default(''),
  /** Graph id of the containing folder (the source itself at its root). */
  parentItemId: z.string().default(''),
  size: z.number().default(0),
  mimeType: z.string().optional(),
  eTag: z.string().optional(),
  webUrl: z.string().default(''),
  lastModified: z.string().optional(),
  tier: M365ManifestTierSchema,
  reason: M365ManifestSkipReasonSchema.optional(),
  status: M365ManifestItemStatusSchema.optional(),
  indexedChunks: z.number().optional(),
  error: z.string().optional(),
});
export type M365ManifestItem = z.infer<typeof M365ManifestItemSchema>;

/** A folder discovered under a source — the plan view's tree nodes. */
export const M365ManifestFolderSchema = z.object({
  itemId: z.string().min(1),
  name: z.string(),
  path: z.string().default(''),
  parentItemId: z.string().default(''),
});
export type M365ManifestFolder = z.infer<typeof M365ManifestFolderSchema>;

export const M365ManifestSourceSchema = z.object({
  sourceId: z.string().min(1),
  /** Enumeration hit the ceiling — the listing is incomplete. */
  truncated: z.boolean().default(false),
  /** Graph delta link captured by the plan, for incremental refresh. */
  deltaLink: z.string().optional(),
  folders: z.array(M365ManifestFolderSchema).default([]),
  items: z.array(M365ManifestItemSchema).default([]),
});
export type M365ManifestSource = z.infer<typeof M365ManifestSourceSchema>;

/**
 * The per-agent manifest: what the last index run saw under every source
 * and what it did with each file. Written by the index route only; read by
 * the editor (per-item outcomes) and by the layer-2 trim (which item ids
 * are indexed under a folder source).
 */
export const M365AgentManifestSchema = z.object({
  version: z.literal(1),
  agentId: z.string().min(1),
  updatedAt: z.string(),
  sources: z.array(M365ManifestSourceSchema).default([]),
});
export type M365AgentManifest = z.infer<typeof M365AgentManifestSchema>;

/**
 * An M365 file-backed RAG agent (docs/M365_SECOND_PASS_AGENTS_DESIGN.md):
 * OneDrive/SharePoint files indexed into the shared m365-agents search index
 * and answered over at chat time, with retrieval trimmed per requesting user
 * to the sources their own Graph token can open. Read-side permissive per
 * the schema-evolution rule.
 */
export const M365AgentSchema = z.object({
  version: z.literal(1),
  /** Server-generated `m365-<hex>`; immutable — canonical keys hang off it. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  systemPrompt: z.string().default(''),
  /** null → ride getDefaultModel() at request time. */
  chatModelId: z.string().nullable().default(null),
  /**
   * Embedding deployment used for ingestion AND query embedding — never
   * user-overridable (query vectors must match the indexed vectors).
   */
  embeddingModelId: z.string().default(''),
  ragConfig: z.object({ topK: z.number().default(10) }).default({ topK: 10 }),
  sources: z.array(M365AgentSourceSchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type M365Agent = z.infer<typeof M365AgentSchema>;

/**
 * Immutable audit copy written alongside every successful m365-agent write
 * (including deletes, which record a null tombstone).
 */
export const M365AgentHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full record as written, or null for a delete tombstone. */
  m365Agent: M365AgentSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type M365AgentHistoryEntry = z.infer<typeof M365AgentHistoryEntrySchema>;

/**
 * Azure AI Search index names: 2–128 chars, lowercase letters / digits /
 * dashes, no leading/trailing dash. Also keeps the name URL-path-safe for
 * the REST calls that embed it.
 */
export const SEARCH_INDEX_NAME_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

/**
 * Outcome of the save-time Azure AI Search validation for an org RAG agent.
 * `status: 'ok'` is a serving prerequisite — the registry never serves an
 * agent whose index failed its contract check, so a typo'd or restructured
 * index can never surface as a silently-broken knowledge agent.
 */
export const OrgAgentValidationSchema = z.object({
  status: z.enum(['ok', 'failed']),
  checkedAt: z.string(),
  /** Documents in the index at check time; 0 usually means "still staging". */
  documentCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type OrgAgentValidation = z.infer<typeof OrgAgentValidationSchema>;

/**
 * An admin-authored organization RAG agent: the blob-store counterpart of a
 * config/organization-agents.json entry (type 'rag'), pointing at an
 * existing Azure AI Search index on the org search endpoint. The registry
 * (lib/services/orgAgents/orgAgentRegistry.ts) merges these records over the
 * static file — a record whose id matches a static agent OVERRIDES it
 * (including `enabled: false` to retire a file agent without a deploy);
 * other ids are server-generated `orgr-<hex>`. Read-side permissive per the
 * schema-evolution rule.
 */
export const OrgRagAgentSchema = z.object({
  version: z.literal(1),
  /** `orgr-<hex>` (server-generated) or a static config id (override). */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Tabler icon name; unknown names fall back to IconRobot client-side. */
  icon: z.string().default('IconHexagon'),
  color: z.string().default('#4190f2'),
  category: z.string().default(''),
  maintainedBy: z.string().default(''),
  systemPrompt: z.string().default(''),
  /** Attribution links shown in the agent details panel. */
  sources: z
    .array(z.object({ name: z.string().min(1), url: z.string().default('') }))
    .default([]),
  /** Index on SEARCH_ENDPOINT backing retrieval — the validation anchor. */
  searchIndex: z.string().regex(SEARCH_INDEX_NAME_REGEX),
  /** Empty → `${searchIndex}-semantic-configuration` (ragService default). */
  semanticConfig: z.string().default(''),
  topK: z.number().int().default(10),
  /** null → ride the catalog default at request time. */
  baseModelId: z.string().nullable().default(null),
  allowWebSearch: z.boolean().default(false),
  allowCodeInterpreter: z.boolean().default(false),
  enabled: z.boolean().default(true),
  validation: OrgAgentValidationSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type OrgRagAgent = z.infer<typeof OrgRagAgentSchema>;

/**
 * Immutable audit copy written alongside every successful org-agent write
 * (including deletes, which record a null tombstone).
 */
export const OrgRagAgentHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full record as written, or null for a delete tombstone. */
  orgAgent: OrgRagAgentSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type OrgRagAgentHistoryEntry = z.infer<
  typeof OrgRagAgentHistoryEntrySchema
>;

/**
 * An OAuth client secret sealed by connectorSecretCrypto. Declared HERE
 * rather than alongside the crypto so this module stays importable from
 * client components — connectorSecretCrypto pulls in node:crypto and would
 * poison the browser bundle.
 */
export const SealedSecretSchema = z.object({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  /** Base64, 12 bytes, fresh per seal. */
  iv: z.string().min(1),
  /** Base64 ciphertext with the GCM tag appended. */
  ct: z.string().min(1),
});
export type SealedSecret = z.infer<typeof SealedSecretSchema>;

export const McpConnectorTransportSchema = z.enum(['streamable-http', 'sse']);
export const McpConnectorAuthStyleSchema = z.enum(['none', 'bearer', 'oauth']);
export type McpConnectorAuthStyle = z.infer<typeof McpConnectorAuthStyleSchema>;

/**
 * An admin-authored MCP connector: a tenant-specific server URL (NetSuite's
 * per-account host, a customer's own Matomo, …) that the curated compile-time
 * catalog cannot express. Resolved server-side as TRUSTED — the URL never
 * comes from the client — and gated by the same access rules as agents.
 *
 * Read-side permissive per the schema-evolution rule: new fields must be
 * optional/defaulted so previously-stored blobs keep parsing.
 */
export const McpConnectorSchema = z.object({
  version: z.literal(1),
  /** Server-generated `connector-<hex>`; immutable — canonical keys hang off it. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  url: z.string().url(),
  transport: McpConnectorTransportSchema.default('streamable-http'),
  authStyle: McpConnectorAuthStyleSchema,
  /** Where a user creates their token (bearer style only). */
  tokenHelpUrl: z.string().optional(),
  /** OAuth style only — the app registered in the vendor's console. */
  oauthClientId: z.string().optional(),
  /**
   * OAuth style only. ALWAYS sealed — the plaintext must never touch a blob,
   * and must never be echoed back to a client (the admin API returns only a
   * hasClientSecret boolean).
   */
  oauthClientSecret: SealedSecretSchema.optional(),
  oauthScopes: z.array(z.string()).default([]),
  /**
   * OAuth style only — explicit endpoints for providers whose MCP server does
   * not publish RFC 9728/8414 discovery metadata (NetSuite's are per-account).
   * Authorization + token URLs come as a pair; the refresh URL is optional and
   * defaults to the token URL. When absent, discovery runs as before.
   */
  oauthAuthorizationUrl: z.string().optional(),
  oauthTokenUrl: z.string().optional(),
  oauthRefreshUrl: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type McpConnector = z.infer<typeof McpConnectorSchema>;

/**
 * Immutable audit copy written alongside every successful connector write
 * (including deletes, which record a null-connector tombstone).
 */
export const McpConnectorHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full record as written, or null for a delete tombstone. */
  connector: McpConnectorSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type McpConnectorHistoryEntry = z.infer<
  typeof McpConnectorHistoryEntrySchema
>;

/**
 * Deployment-level OAuth app for one curated catalog connector, stored so
 * admins can manage these credentials in Admin → Connectors instead of the
 * MCP_OAUTH_* env vars (which remain the fallback when no record exists).
 * The record id IS the MCP_CATALOG key (e.g. 'github'), which also binds the
 * sealed secret's AAD — catalog keys can never collide with `connector-<hex>`
 * ids, so the two sealed namespaces stay distinct.
 */
export const CatalogOauthAppSchema = z.object({
  version: z.literal(1),
  /** The MCP_CATALOG key this app belongs to; immutable. */
  id: z.string().min(1),
  clientId: z.string().min(1),
  /** ALWAYS sealed; never echoed to clients (hasClientSecret only). */
  clientSecret: SealedSecretSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type CatalogOauthApp = z.infer<typeof CatalogOauthAppSchema>;

/** Immutable audit copy for catalog OAuth app writes (null = delete). */
export const CatalogOauthAppHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  app: CatalogOauthAppSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type CatalogOauthAppHistoryEntry = z.infer<
  typeof CatalogOauthAppHistoryEntrySchema
>;

export const GuideKindSchema = z.enum([
  'style',
  'terminology',
  'compliance',
  'structure',
  'tone',
]);
export type GuideKind = z.infer<typeof GuideKindSchema>;

export const GuideWorkflowSchema = z.enum(['document', 'translation']);
export type GuideWorkflow = z.infer<typeof GuideWorkflowSchema>;

/**
 * Structurally matches DocumentSpecSection (types/workflow.ts) — the shape
 * buildSpecBlock consumes. Declared here (not imported as a schema) so this
 * module stays self-contained; the guidePayload() return type asserts the
 * structural match at compile time.
 */
export const GuideSpecSectionSchema = z.object({
  heading: z.string().min(1),
  guidance: z.string().optional(),
  required: z.boolean(),
});

/** Structurally matches GlossaryEntry (types/workflow.ts). */
export const GuideGlossaryEntrySchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  note: z.string().optional(),
});

/**
 * An admin-authored workflow guide: office style guide, terminology
 * glossary, compliance checklist, document structure spec, or tone profile,
 * applied in the document/translation workflows. Resolved server-side by id,
 * so the payload is NOT subject to the client-sent custom-criterion rubric
 * cap. Visibility uses the same access rules as agents (keyed `guide::<id>`),
 * never an embedded allow-list.
 *
 * The payload is kind-discriminated but stored FLAT with every field
 * optional: read-side permissive per the schema-evolution rule (previously-
 * stored blobs keep parsing), with {@link guidePayload} as the narrowing
 * gate — an incoherent record (e.g. a legacy body-only tone guide) narrows
 * to null and callers fail closed. The admin write route enforces the strict
 * per-kind shape.
 */
export const GuideSchema = z.object({
  version: z.literal(1),
  /** Server-generated `guide-<hex>`; immutable — canonical keys hang off it. */
  id: z.string().min(1),
  kind: GuideKindSchema,
  name: z.string().min(1),
  description: z.string().default(''),
  /** Advisory picker metadata (e.g. ['French']); never evaluated. */
  languages: z.array(z.string()).default([]),
  /** style/compliance: markdown rubric, token-budgeted at injection. */
  body: z.string().optional(),
  /** tone: voice rules + optional examples (ToneInput shape). */
  voiceRules: z.string().optional(),
  examples: z.string().optional(),
  /** structure: document spec sections + optional general guidance. */
  sections: z.array(GuideSpecSectionSchema).optional(),
  generalGuidance: z.string().optional(),
  /** terminology: mandatory glossary entries. */
  entries: z.array(GuideGlossaryEntrySchema).optional(),
  /** structure/tone kinds are document-only (translation has no spec/tone slots). */
  workflows: z.array(GuideWorkflowSchema).default(['document']),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type Guide = z.infer<typeof GuideSchema>;

export type GuideSpecSection = z.infer<typeof GuideSpecSectionSchema>;
export type GuideGlossaryEntry = z.infer<typeof GuideGlossaryEntrySchema>;

/**
 * The kind-discriminated view of a guide's payload. Prompt builders consume
 * this, never the flat record, so a wrong-kind field can't leak into a
 * prompt.
 */
export type GuidePayload =
  | { kind: 'style' | 'compliance'; body: string }
  | { kind: 'tone'; voiceRules: string; examples?: string }
  | {
      kind: 'structure';
      sections: GuideSpecSection[];
      generalGuidance?: string;
    }
  | { kind: 'terminology'; entries: GuideGlossaryEntry[] };

/**
 * Narrows a stored guide to its kind's payload. Returns null when the record
 * lacks its kind's required fields — legacy body-only structured-kind guides
 * (pre-structured-payload dev data) land here, and every caller fails closed
 * on null exactly as it would for an unknown guide.
 */
export function guidePayload(guide: Guide): GuidePayload | null {
  switch (guide.kind) {
    case 'style':
    case 'compliance':
      if (!guide.body) return null;
      return { kind: guide.kind, body: guide.body };
    case 'tone':
      if (!guide.voiceRules) return null;
      return {
        kind: 'tone',
        voiceRules: guide.voiceRules,
        examples: guide.examples,
      };
    case 'structure':
      if (!guide.sections || guide.sections.length === 0) return null;
      return {
        kind: 'structure',
        sections: guide.sections,
        generalGuidance: guide.generalGuidance,
      };
    case 'terminology':
      if (!guide.entries || guide.entries.length === 0) return null;
      return { kind: 'terminology', entries: guide.entries };
  }
}

/**
 * Immutable audit copy written alongside every successful guide write
 * (including deletes, which record a null-guide tombstone).
 */
export const GuideHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full record as written, or null for a delete tombstone. */
  guide: GuideSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type GuideHistoryEntry = z.infer<typeof GuideHistoryEntrySchema>;

/* ------------------------------------------------------------------ */
/* Map datasets                                                        */
/* ------------------------------------------------------------------ */

export const MapDatasetEventRangeSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1).nullable(),
  precision: z.enum(['minute', 'hour', 'day', 'month', 'year']),
  ongoing: z.boolean().optional(),
});

/** Structurally matches MapFeature (types/workflow.ts) minus nothing — the
 * dataset stores workspace-shaped features verbatim, ids stable within the
 * dataset (loads remap them). */
export const MapDatasetFeatureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  lat: z.number(),
  lon: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
  confidenceReason: z.string().default(''),
  category: z.string().default(''),
  event: MapDatasetEventRangeSchema.optional(),
  prominence: z.enum(['primary', 'secondary', 'mention']).optional(),
  granularity: z
    .enum(['site', 'city', 'district', 'region', 'country'])
    .optional(),
  countryCode: z.string().optional(),
  parentName: z.string().optional(),
  approxRadiusKm: z.number().optional(),
  sourceId: z.string().optional(),
});

export const MapDatasetConnectionSchema = z.object({
  id: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  kind: z.string().default(''),
  description: z.string().default(''),
  sourceId: z.string().optional(),
});

/** Generation provenance (which runs produced the features). */
export const MapDatasetSourceRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  addedAt: z.string(),
  featureCount: z.number().int().nonnegative(),
  kind: z.enum(['text', 'file', 'search', 'url']).optional(),
  query: z.string().optional(),
  url: z.string().optional(),
});

/**
 * An admin-curated map dataset — the DATA blob. Unlike every other
 * agent-access entity this can reach ~1MB (2,000 features), so datasets
 * deliberately NEVER enter the AgentAccessService snapshot: listings read
 * the derived META blobs and loads read this blob directly. Access rides
 * the ordinary rules (keyed `map-dataset::<id>`), which the snapshot
 * already carries entity-agnostically.
 *
 * Read-side permissive per the schema-evolution rule.
 */
export const MapDatasetSchema = z.object({
  version: z.literal(1),
  /** Server-generated `mapds-<hex>`; immutable — canonical keys hang off it. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  features: z.array(MapDatasetFeatureSchema).default([]),
  connections: z.array(MapDatasetConnectionSchema).default([]),
  sources: z.array(MapDatasetSourceRecordSchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type MapDataset = z.infer<typeof MapDatasetSchema>;
export type MapDatasetFeature = z.infer<typeof MapDatasetFeatureSchema>;
export type MapDatasetConnection = z.infer<typeof MapDatasetConnectionSchema>;
export type MapDatasetSourceRecord = z.infer<
  typeof MapDatasetSourceRecordSchema
>;

/**
 * Derived listing record (META blob) — rewritten after every successful data
 * write. May lag the data blob briefly if a meta write fails (logged loudly;
 * self-heals on the next save): listings can be stale, loads are truth.
 */
export const MapDatasetMetaSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  featureCount: z.number().int().nonnegative(),
  connectionCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type MapDatasetMeta = z.infer<typeof MapDatasetMetaSchema>;

/** Derives the META record from a dataset. */
export function mapDatasetMeta(dataset: MapDataset): MapDatasetMeta {
  return {
    version: 1,
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    tags: dataset.tags,
    featureCount: dataset.features.length,
    connectionCount: dataset.connections.length,
    createdBy: dataset.createdBy,
    createdAt: dataset.createdAt,
    updatedBy: dataset.updatedBy,
    updatedAt: dataset.updatedAt,
  };
}

/**
 * Immutable audit copy per dataset write. Carries the META only — a
 * deliberate deviation from the other entities: a ~1MB verbatim payload per
 * save would turn the audit trail into a second store.
 */
export const MapDatasetHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  meta: MapDatasetMetaSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type MapDatasetHistoryEntry = z.infer<
  typeof MapDatasetHistoryEntrySchema
>;

/**
 * ARM resource paths are case-insensitive to Azure but compared as raw
 * strings elsewhere in the app — rule matching MUST canonicalize both halves
 * (lowercase + trim) to prevent case-variant bypass.
 */
export function canonicalAgentKey(source: string, agentName: string): string {
  return `${source.trim().toLowerCase()}::${agentName.trim().toLowerCase()}`;
}

/** `system/agent-access/rules/<sha256(canonicalKey)>.json` */
export function ruleBlobPath(canonicalKey: string): string {
  return `${AGENT_ACCESS_RULES_PREFIX}${Hasher.sha256(canonicalKey)}.json`;
}

/** `system/agent-access/history/<sha256(canonicalKey)>/<iso-ts>.json` */
export function historyBlobPath(
  canonicalKey: string,
  isoTimestamp: string,
): string {
  return `${AGENT_ACCESS_HISTORY_PREFIX}${Hasher.sha256(canonicalKey)}/${isoTimestamp}.json`;
}

/** Listing prefix for one canonical key's history entries. */
export function historyListPrefix(canonicalKey: string): string {
  return `${AGENT_ACCESS_HISTORY_PREFIX}${Hasher.sha256(canonicalKey)}/`;
}

/**
 * The entity-agnostic slice every history entry shares. The full payload
 * rides along verbatim (entries are written per-entity — rule, promptAgent,
 * m365Agent, orgAgent, connector, guide, or meta fields), so a generic
 * history listing can serve any entity without knowing its shape.
 */
export const HistoryEntryEnvelopeSchema = z.looseObject({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type HistoryEntryEnvelope = z.infer<typeof HistoryEntryEnvelopeSchema>;

/**
 * `system/agent-access/prompt-agents/<id>.json` — a SIBLING of rules/, never
 * under it: listAllRules is fail-closed and an alien blob there would brick
 * every Foundry invocation.
 */
export function promptAgentBlobPath(id: string): string {
  return `${AGENT_ACCESS_PROMPT_AGENTS_PREFIX}${id}.json`;
}

/**
 * `system/agent-access/connectors/<id>.json` — a SIBLING of rules/ for the
 * same reason as prompt-agents/: listAllRules is fail-closed, so an alien
 * blob under rules/ would brick every Foundry invocation.
 */
export function connectorBlobPath(id: string): string {
  return `${AGENT_ACCESS_CONNECTORS_PREFIX}${id}.json`;
}

/**
 * `system/agent-access/guides/<id>.json` — a SIBLING of rules/ for the same
 * reason as prompt-agents/ and connectors/: listAllRules is fail-closed, so
 * an alien blob under rules/ would brick every Foundry invocation.
 */
export function guideBlobPath(id: string): string {
  return `${AGENT_ACCESS_GUIDES_PREFIX}${id}.json`;
}

/**
 * `system/agent-access/catalog-oauth/<catalogKey>.json` — a SIBLING of
 * rules/ for the same reason as the other entity prefixes: listAllRules is
 * fail-closed, so an alien blob under rules/ would brick every invocation.
 */
export function catalogOauthBlobPath(id: string): string {
  return `${AGENT_ACCESS_CATALOG_OAUTH_PREFIX}${id}.json`;
}

/**
 * `system/agent-access/map-datasets/meta/<id>.json` and
 * `.../map-datasets/data/<id>.json` — SIBLINGS of rules/ for the same
 * reason as the other entities (listAllRules is fail-closed). Split because
 * the data blob can be ~1MB: listings read meta only; loads read data.
 */
export function mapDatasetMetaBlobPath(id: string): string {
  return `${AGENT_ACCESS_MAP_DATASET_META_PREFIX}${id}.json`;
}

export function mapDatasetDataBlobPath(id: string): string {
  return `${AGENT_ACCESS_MAP_DATASET_DATA_PREFIX}${id}.json`;
}

/**
 * `system/agent-access/m365-agents/<id>.json` — a SIBLING of rules/ for the
 * same reason as the other entities: listAllRules is fail-closed, so an
 * alien blob under rules/ would brick every Foundry invocation.
 */
export function m365AgentManifestBlobPath(id: string): string {
  return `${AGENT_ACCESS_M365_MANIFESTS_PREFIX}${id}.json`;
}

export function m365AgentBlobPath(id: string): string {
  return `${AGENT_ACCESS_M365_AGENTS_PREFIX}${id}.json`;
}

/**
 * `system/agent-access/org-agents/<id>.json` — a SIBLING of rules/ for the
 * same reason as the other entities: listAllRules is fail-closed, so an
 * alien blob under rules/ would brick every Foundry invocation.
 */
export function orgAgentBlobPath(id: string): string {
  return `${AGENT_ACCESS_ORG_AGENTS_PREFIX}${id}.json`;
}
