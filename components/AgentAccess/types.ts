import type {
  AgentAccessConfig,
  AgentAccessRule,
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
  /** 'prompt' = app-defined prompt agent; absent/'foundry' = Foundry agent. */
  type?: 'foundry' | 'prompt';
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
