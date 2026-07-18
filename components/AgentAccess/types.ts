import type {
  AgentAccessConfig,
  AgentAccessRule,
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

/** Subset of /api/agents' DiscoveredAgent the admin panel consumes. */
export interface DiscoveredAgentSummary {
  id: string;
  name: string;
  agentName: string;
  source?: string;
}

export interface AgentsApiResponse {
  agents: DiscoveredAgentSummary[];
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
