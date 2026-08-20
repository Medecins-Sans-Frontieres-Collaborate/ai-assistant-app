import { useFlags } from 'launchdarkly-react-client-sdk';
import { useMemo } from 'react';

import { useFoundryAgents } from '@/client/hooks/settings/useFoundryAgents';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  AvailableAgent,
  synthesizeFoundryAgentModel,
  synthesizeStaticFoundryAgentModel,
} from '@/lib/utils/app/agentAttachment';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { getOrganizationAgents } from '@/lib/organizationAgents';

/**
 * Every agent the current user can attach to a conversation, normalized
 * across the five sources (static config, admin org records, prompt agents,
 * m365 agents, discovered Foundry agents) — the single list behind the
 * agent browser, the composer agent chip, and the tool-gate checks.
 *
 * Mirrors the visibility rules of ModelSelect's synthesized-model layer
 * (exploreBots gates org-managed discovery but never the user's own
 * connected sources; admin-suppressed static ids are dropped) without
 * synthesizing fake models for the org kinds — those attach bot-only.
 */
export function useAvailableAgents(): {
  agents: AvailableAgent[];
  isLoading: boolean;
} {
  const { exploreBots } = useFlags();
  const isBotsEnabled = exploreBots !== false;
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const { foundryAgents, suppressedOrgAgentIds, isLoadingFoundryAgents } =
    useFoundryAgents();

  const agents = useMemo<AvailableAgent[]>(() => {
    const customSourcePaths = new Set(
      customAgentSources.map((s) => s.resourcePath),
    );
    const visibleDiscovered = isBotsEnabled
      ? foundryAgents
      : foundryAgents.filter(
          (a) => a.source && customSourcePaths.has(a.source),
        );

    const suppressed = new Set(suppressedOrgAgentIds);
    const staticAgents = isBotsEnabled
      ? getOrganizationAgents().filter((a) => !suppressed.has(a.id))
      : [];

    const result: AvailableAgent[] = [];

    for (const agent of staticAgents) {
      if (agent.type === 'foundry') {
        result.push({
          id: agent.id,
          botId: agent.id,
          name: agent.name,
          description: agent.description,
          kind: 'foundry',
          category: agent.category,
          foundryModel: synthesizeStaticFoundryAgentModel(agent),
        });
      } else {
        result.push({
          id: agent.id,
          botId: agent.id,
          name: agent.name,
          description: agent.description,
          kind: 'rag',
          category: agent.category,
          allowWebSearch: agent.allowWebSearch,
          allowCodeInterpreter: agent.allowCodeInterpreter,
        });
      }
    }

    // Dedup rule matches ModelSelect: a static Foundry agent that also
    // appears in dynamic discovery yields to the discovered (RBAC-checked)
    // entry.
    const discoveredAgentNames = new Set(
      visibleDiscovered
        .filter(
          (a) => a.type !== 'prompt' && a.type !== 'm365' && a.type !== 'org',
        )
        .map((a) => a.agentName),
    );
    const deduped = result.filter(
      (a) =>
        a.kind !== 'foundry' ||
        !a.foundryModel?.agentId ||
        !discoveredAgentNames.has(a.foundryModel.agentId),
    );

    for (const agent of visibleDiscovered) {
      if (agent.type === 'prompt' || agent.type === 'm365') {
        deduped.push({
          id: agent.id,
          botId: agent.id,
          name: agent.name,
          description: agent.description,
          kind: agent.type,
          category: agent.category,
        });
      } else if (agent.type === 'org') {
        deduped.push({
          id: agent.id,
          botId: agent.id,
          name: agent.name,
          description: agent.description,
          kind: 'org',
          category: agent.category,
          allowWebSearch: agent.allowWebSearch === true,
          allowCodeInterpreter: agent.allowCodeInterpreter === true,
        });
      } else {
        deduped.push({
          id: `foundry-${agent.id}`,
          name: agent.name,
          description: agent.description,
          kind: 'foundry',
          category: agent.category,
          foundryModel: synthesizeFoundryAgentModel(agent),
        });
      }
    }

    return deduped;
  }, [isBotsEnabled, foundryAgents, customAgentSources, suppressedOrgAgentIds]);

  return { agents, isLoading: isLoadingFoundryAgents };
}

/**
 * True when the agent browser would show at least one row for this user:
 * any reachable agent, a configured MCP connector, or the builtin
 * Microsoft 365 toolset (flag on + connected). Entry points (e.g. the
 * sidebar's Agents button) hide themselves when this is false so users
 * never land in an empty browser. Mirrors AgentBrowserModal's `allItems`
 * sources exactly — keep the two in sync.
 */
export function useAgentBrowserHasItems(): boolean {
  const { agents } = useAvailableAgents();
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const { toolsEnabled } = useM365Enabled();
  return (
    agents.length > 0 ||
    mcpServers.length > 0 ||
    (toolsEnabled && m365Connected)
  );
}

/**
 * Resolve the agent attached to a conversation — decoupled attachments by
 * bot id, legacy model-swapped selections by synthesized model id.
 */
export function findAttachedAgent(
  agents: AvailableAgent[],
  conversation:
    | { bot?: string; model?: { id?: string } | null }
    | null
    | undefined,
): AvailableAgent | undefined {
  if (!conversation) return undefined;
  if (conversation.bot) {
    const byBot = agents.find((a) => a.botId === conversation.bot);
    if (byBot) return byBot;
  }
  const modelId = conversation.model?.id;
  if (modelId && modelId.startsWith('foundry-')) {
    return agents.find((a) => a.foundryModel?.id === modelId);
  }
  return undefined;
}
