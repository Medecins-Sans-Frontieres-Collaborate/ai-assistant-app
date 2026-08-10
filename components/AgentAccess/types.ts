import type {
  AgentAccessConfig,
  AgentAccessRule,
  Guide,
  M365Agent,
  MapDataset,
  MapDatasetMeta,
  OrgRagAgent,
  PromptAgent,
} from '@/lib/services/agentAccess/types';

/**
 * Client-side types for the agent-access admin panel. Server schemas are
 * imported type-only: lib/services/agentAccess/types.ts pulls in node
 * `crypto` at runtime, so no value imports from it here.
 */

/** One rule as served by GET /api/agent-access/rules (etag for If-Match). */
export interface AdminStoredRule {
  canonicalKey: string;
  rule: AgentAccessRule;
  etag: string;
}

export interface AdminRulesResponse {
  rules: AdminStoredRule[];
  /**
   * True while the rules store is unreachable: `rules` is then empty and
   * MUST NOT be rendered as "everything is Everyone" — invocation is
   * failing closed server-side meanwhile.
   */
  rulesUnavailable?: boolean;
  /** Epoch ms of the served snapshot; null while rulesUnavailable. */
  fetchedAt?: number | null;
}

/** GET/PUT /api/agent-access/config payload (etag null = no config yet). */
export interface AdminConfigResponse {
  config: AgentAccessConfig | null;
  etag: string | null;
}

/**
 * Client mirror of PROMPT_AGENT_SOURCE from lib/services/agentAccess/types.ts
 * (value import forbidden here — see the module comment above). The
 * pseudo-source half of every prompt agent's canonical key.
 */
export const CLIENT_PROMPT_AGENT_SOURCE = 'prompt-agent';

/** Subset of /api/agents' DiscoveredAgent the admin panel consumes. */
export interface DiscoveredAgentSummary {
  id: string;
  name: string;
  agentName: string;
  source?: string;
  description?: string;
  /**
   * 'prompt' = app-defined prompt agent; 'm365' = M365 file-backed agent;
   * absent/'foundry' = Foundry agent.
   */
  type?: 'foundry' | 'prompt' | 'm365';
}

export interface AgentsApiResponse {
  agents: DiscoveredAgentSummary[];
}

/**
 * One prompt agent as served by GET /api/agent-access/prompt-agents (the
 * etag feeds the If-Match CAS on PUT/DELETE).
 */
export interface AdminStoredPromptAgent {
  canonicalKey: string;
  agent: PromptAgent;
  etag: string;
}

export interface AdminPromptAgentsResponse {
  promptAgents: AdminStoredPromptAgent[];
  /**
   * True while the prompt-agents store is unreachable: same outage contract
   * as rulesUnavailable — the list is empty and MUST NOT be rendered as
   * "no prompt agents exist".
   */
  promptAgentsUnavailable?: boolean;
  /** Epoch ms of the served snapshot; null while promptAgentsUnavailable. */
  fetchedAt?: number | null;
}

/**
 * Client mirror of M365_AGENT_SOURCE (value import forbidden here — see the
 * module comment above). The pseudo-source half of every M365 agent's
 * canonical key.
 */
export const CLIENT_M365_AGENT_SOURCE = 'm365-agent';

/**
 * One M365 agent as served by GET /api/agent-access/m365-agents (the etag
 * feeds the If-Match CAS on PUT/DELETE).
 */
export interface AdminStoredM365Agent {
  canonicalKey: string;
  agent: M365Agent;
  etag: string;
}

export interface AdminM365AgentsResponse {
  m365Agents: AdminStoredM365Agent[];
  /** Same outage contract as promptAgentsUnavailable. */
  m365AgentsUnavailable?: boolean;
  fetchedAt?: number | null;
  /** Server's env-configured per-agent document cap (M365_AGENT_MAX_DOCUMENTS). */
  maxDocuments?: number;
}

/**
 * Client mirror of ORG_AGENT_SOURCE (value import forbidden here — see the
 * module comment above). The pseudo-source half of every org RAG agent's
 * canonical key.
 */
export const CLIENT_ORG_AGENT_SOURCE = 'org-agent';

/**
 * One org RAG agent as served by GET /api/agent-access/org-agents (the etag
 * feeds the If-Match CAS on PUT/DELETE).
 */
export interface AdminStoredOrgAgent {
  canonicalKey: string;
  agent: OrgRagAgent;
  etag: string;
}

/**
 * One audit entry from GET /api/agent-access/history. The envelope fields
 * are entity-agnostic; the per-entity payload (orgAgent, promptAgent, …)
 * rides along verbatim — consumers narrow to the field they expect.
 */
export interface AdminHistoryEntry {
  version: 1;
  canonicalKey: string;
  action: 'upsert' | 'delete';
  updatedBy: string;
  updatedAt: string;
  /** Present on org-agent entries: the full record as written (null = delete tombstone). */
  orgAgent?: OrgRagAgent | null;
}

export interface AdminHistoryResponse {
  canonicalKey: string;
  entries: AdminHistoryEntry[];
  /** True when older entries were cut off at the server's cap. */
  truncated?: boolean;
}

export interface AdminOrgAgentsResponse {
  orgAgents: AdminStoredOrgAgent[];
  /** Same outage contract as promptAgentsUnavailable. */
  orgAgentsUnavailable?: boolean;
  fetchedAt?: number | null;
  /** Static config agent ids offered as override targets. */
  staticAgentIds?: string[];
  /** Creation is global-admin only; the server reports whether to offer it. */
  canCreate?: boolean;
}

/**
 * Client mirror of MCP_CONNECTOR_SOURCE (value import forbidden here — see
 * the module comment above). The pseudo-source half of every connector's
 * canonical key.
 */
export const CLIENT_MCP_CONNECTOR_SOURCE = 'mcp-connector';

/**
 * A connector as served by GET /api/agent-access/connectors. Mirrors the
 * server's admin view: the sealed OAuth secret is replaced by a boolean, so
 * this type deliberately has no field that could hold one.
 */
export interface AdminConnectorView {
  id: string;
  name: string;
  description: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  authStyle: 'none' | 'bearer' | 'oauth';
  tokenHelpUrl?: string;
  oauthClientId?: string;
  oauthScopes: string[];
  oauthAuthorizationUrl?: string;
  oauthTokenUrl?: string;
  oauthRefreshUrl?: string;
  hasClientSecret: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AdminStoredConnector {
  canonicalKey: string;
  connector: AdminConnectorView;
  etag: string;
}

export interface AdminConnectorsResponse {
  connectors: AdminStoredConnector[];
  /** Same outage contract as rulesUnavailable — empty ≠ "none exist". */
  connectorsUnavailable?: boolean;
  /**
   * False when the deployment has no AUTH_SECRET to seal client secrets
   * with: the editor must then disable the oauth style and explain why,
   * rather than offering a choice the server will reject with 503.
   */
  secretSealingAvailable?: boolean;
  fetchedAt?: number | null;
}

/**
 * Client mirror of GUIDE_SOURCE (value import forbidden here — see the
 * module comment above). The pseudo-source half of every guide's canonical
 * key.
 */
export const CLIENT_GUIDE_SOURCE = 'guide';

/**
 * A guide as served by GET /api/agent-access/guides (full record including
 * body; the etag feeds the If-Match CAS on PUT/DELETE).
 */
export interface AdminStoredGuide {
  canonicalKey: string;
  guide: Guide;
  etag: string;
}

export interface AdminGuidesResponse {
  guides: AdminStoredGuide[];
  /** Same outage contract as rulesUnavailable — empty ≠ "none exist". */
  guidesUnavailable?: boolean;
  fetchedAt?: number | null;
}

/**
 * Client mirror of MAP_DATASET_SOURCE (value import forbidden here — see
 * the module comment above). The pseudo-source half of every dataset's
 * canonical key.
 */
export const CLIENT_MAP_DATASET_SOURCE = 'map-dataset';

/** One dataset META row as served by GET /api/agent-access/map-datasets. */
export interface AdminStoredDatasetMeta {
  canonicalKey: string;
  meta: MapDatasetMeta;
}

export interface AdminMapDatasetsResponse {
  datasets: AdminStoredDatasetMeta[];
  /** Same outage contract as rulesUnavailable — empty ≠ "none exist". */
  datasetsUnavailable?: boolean;
  fetchedAt?: number | null;
}

/** GET/PUT /api/agent-access/map-datasets/[id] payload (data-blob etag). */
export interface AdminMapDatasetResponse {
  dataset: MapDataset;
  etag: string;
  canonicalKey: string;
}

/**
 * One row in the admin list: an agent from the admin's own discovery, a
 * stored rule, or both. `discoverable` false = rule exists but the agent is
 * not in the admin's own /api/agents discovery ("not discoverable by you").
 */
export interface MergedAgentRow {
  canonicalKey: string;
  source: string;
  agentName: string;
  displayName: string;
  discoverable: boolean;
  stored: AdminStoredRule | null;
  /**
   * Present when this row is an app-defined prompt agent the admin may edit
   * (from the admin route, which supplies the record + CAS etag). Prompt
   * agents outside the admin's editable keys never reach the merged list.
   */
  promptAgent: AdminStoredPromptAgent | null;
}

/**
 * Client mirror of canonicalAgentKey() from
 * lib/services/agentAccess/types.ts (kept in sync with that server helper —
 * the format is part of the documented storage contract).
 */
export function clientCanonicalAgentKey(
  source: string,
  agentName: string,
): string {
  return `${source.trim().toLowerCase()}::${agentName.trim().toLowerCase()}`;
}
