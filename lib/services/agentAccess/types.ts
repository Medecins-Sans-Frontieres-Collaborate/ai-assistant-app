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
export const AGENT_ACCESS_PROMPT_AGENTS_PREFIX = `${AGENT_ACCESS_PREFIX}prompt-agents/`;
export const AGENT_ACCESS_CONNECTORS_PREFIX = `${AGENT_ACCESS_PREFIX}connectors/`;

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
