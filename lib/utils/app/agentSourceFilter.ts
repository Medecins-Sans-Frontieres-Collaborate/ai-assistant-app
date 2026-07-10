import type { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

/**
 * The slice of an AgentSource the filter needs. Fields are optional so the
 * filter stays safe against un-migrated persisted blobs — a source missing
 * selection state behaves as "auto-add everything" (the pre-selection
 * behavior), never hiding agents.
 */
export interface AgentSourceSelection {
  resourcePath: string;
  autoAddNewAgents?: boolean;
  excludedAgentNames?: string[];
  selectedAgentNames?: string[];
}

/**
 * Applies per-source agent selection to a discovered-agent list.
 *
 * - Agents whose `source` matches no custom source (regional/office/static)
 *   always pass through.
 * - Source with auto-add ON (default): agent is kept unless its agentName is
 *   in excludedAgentNames.
 * - Source with auto-add OFF: agent is kept only if its agentName is in
 *   selectedAgentNames.
 *
 * Selection is keyed by `agentName` (the stable invocation slug) and scoped
 * per source, so same-named agents in two projects are independent.
 */
export function filterAgentsBySourceSelection(
  agents: DiscoveredAgent[],
  sources: AgentSourceSelection[],
): DiscoveredAgent[] {
  if (sources.length === 0) return agents;

  const bySourcePath = new Map<string, AgentSourceSelection>();
  for (const source of sources) {
    if (source?.resourcePath) {
      bySourcePath.set(source.resourcePath, source);
    }
  }
  if (bySourcePath.size === 0) return agents;

  return agents.filter((agent) => {
    const source = agent.source ? bySourcePath.get(agent.source) : undefined;
    if (!source) return true;

    if (source.autoAddNewAgents === false) {
      return (
        Array.isArray(source.selectedAgentNames) &&
        source.selectedAgentNames.includes(agent.agentName)
      );
    }

    return !(
      Array.isArray(source.excludedAgentNames) &&
      source.excludedAgentNames.includes(agent.agentName)
    );
  });
}
