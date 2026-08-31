'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAdminDiscoveredAgents } from '@/client/hooks/settings/useAdminDiscoveredAgents';
import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import type {
  AdminConnectorsResponse,
  AdminGuidesResponse,
  AdminM365AgentsResponse,
  AdminMapDatasetsResponse,
  AdminOrgAgentsResponse,
  AdminPromptAgentsResponse,
  AdminRulesResponse,
  MergedAgentRow,
} from '@/components/AgentAccess/types';
import {
  CLIENT_PROMPT_AGENT_SOURCE,
  clientCanonicalAgentKey,
} from '@/components/AgentAccess/types';

/** One delegatable thing: a canonical key with a human name. */
export interface DelegationOption {
  canonicalKey: string;
  displayName: string;
  /** Secondary line (agent id, source path, "built-in", …). */
  detail?: string;
}

export type DelegationGroupId =
  | 'agents'
  | 'promptAgents'
  | 'm365Agents'
  | 'orgAgents'
  | 'guides'
  | 'connectors'
  | 'datasets';

export interface DelegationGroup {
  id: DelegationGroupId;
  options: DelegationOption[];
  /** The listing behind this group failed to load. */
  unavailable: boolean;
}

export const DELEGATION_GROUP_ORDER: DelegationGroupId[] = [
  'agents',
  'promptAgents',
  'm365Agents',
  'orgAgents',
  'guides',
  'connectors',
  'datasets',
];

interface UseDelegatableAgentsOptions {
  /**
   * Pre-merged agent rows (the admin panel already has them). When given,
   * the discovery / rules / prompt-agent queries are skipped.
   */
  rows?: MergedAgentRow[];
  /** Label for built-in knowledge agents (caller supplies the translation). */
  builtInLabel: string;
}

async function fetchAdminList<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  return unwrapApiData<T>(await response.json());
}

function byName(a: DelegationOption, b: DelegationOption): number {
  return a.displayName.localeCompare(b.displayName);
}

/**
 * Every canonical key a global admin can delegate (or impersonate a local
 * admin with), grouped and named. Shares query keys with the admin panel
 * so the two never double-fetch; each listing degrades alone.
 */
export function useDelegatableAgents({
  rows,
  builtInLabel,
}: UseDelegatableAgentsOptions) {
  const listQuery = { retry: 1, refetchOnWindowFocus: false } as const;
  const needAgentQueries = rows === undefined;
  const agentsQuery = useAdminDiscoveredAgents({ enabled: needAgentQueries });
  const rulesQuery = useQuery<AdminRulesResponse>({
    queryKey: ['agent-access-rules'],
    queryFn: () => fetchAdminList('/api/agent-access/rules'),
    enabled: needAgentQueries,
    ...listQuery,
  });
  const promptQuery = useQuery<AdminPromptAgentsResponse>({
    queryKey: ['agent-access-prompt-agents'],
    queryFn: () => fetchAdminList('/api/agent-access/prompt-agents'),
    enabled: needAgentQueries,
    ...listQuery,
  });
  const m365Query = useQuery<AdminM365AgentsResponse>({
    queryKey: ['agent-access-m365-agents'],
    queryFn: () => fetchAdminList('/api/agent-access/m365-agents'),
    ...listQuery,
  });
  const orgQuery = useQuery<AdminOrgAgentsResponse>({
    queryKey: ['agent-access-org-agents'],
    queryFn: () => fetchAdminList('/api/agent-access/org-agents'),
    ...listQuery,
  });
  const guidesQuery = useQuery<AdminGuidesResponse>({
    queryKey: ['agent-access-guides'],
    queryFn: () => fetchAdminList('/api/agent-access/guides'),
    ...listQuery,
  });
  const connectorsQuery = useQuery<AdminConnectorsResponse>({
    queryKey: ['agent-access-connectors'],
    queryFn: () => fetchAdminList('/api/agent-access/connectors'),
    ...listQuery,
  });
  const datasetsQuery = useQuery<AdminMapDatasetsResponse>({
    queryKey: ['agent-access-map-datasets'],
    queryFn: () => fetchAdminList('/api/agent-access/map-datasets'),
    ...listQuery,
  });

  const groups = useMemo<DelegationGroup[]>(() => {
    // Agents + prompt agents: from the caller's rows, or merged here the
    // same way the panel does (discovery → rules → prompt records).
    const agentRows = new Map<string, DelegationOption & { prompt: boolean }>();
    if (rows) {
      for (const row of rows) {
        agentRows.set(row.canonicalKey, {
          canonicalKey: row.canonicalKey,
          displayName: row.displayName,
          detail: row.agentName,
          prompt: row.source === CLIENT_PROMPT_AGENT_SOURCE,
        });
      }
    } else {
      for (const agent of agentsQuery.data?.agents ?? []) {
        if (!agent.source || !agent.agentName) continue;
        const key = clientCanonicalAgentKey(agent.source, agent.agentName);
        if (!agentRows.has(key)) {
          agentRows.set(key, {
            canonicalKey: key,
            displayName: agent.name || agent.agentName,
            detail: agent.agentName,
            prompt: agent.source === CLIENT_PROMPT_AGENT_SOURCE,
          });
        }
      }
      for (const stored of rulesQuery.data?.rules ?? []) {
        if (!agentRows.has(stored.canonicalKey)) {
          agentRows.set(stored.canonicalKey, {
            canonicalKey: stored.canonicalKey,
            displayName: stored.rule.agentName,
            detail: stored.rule.source,
            prompt: stored.rule.source === CLIENT_PROMPT_AGENT_SOURCE,
          });
        }
      }
      for (const entry of promptQuery.data?.promptAgents ?? []) {
        agentRows.set(entry.canonicalKey, {
          canonicalKey: entry.canonicalKey,
          displayName: entry.agent.name,
          detail: entry.agent.id,
          prompt: true,
        });
      }
    }
    const agents: DelegationOption[] = [];
    const promptAgents: DelegationOption[] = [];
    for (const { prompt, ...option } of agentRows.values()) {
      (prompt ? promptAgents : agents).push(option);
    }

    const lists: Record<
      DelegationGroupId,
      { options: DelegationOption[]; unavailable: boolean }
    > = {
      agents: {
        options: agents,
        unavailable: needAgentQueries && agentsQuery.isError,
      },
      promptAgents: {
        options: promptAgents,
        unavailable: needAgentQueries && promptQuery.isError,
      },
      m365Agents: {
        options: (m365Query.data?.m365Agents ?? []).map((entry) => ({
          canonicalKey: entry.canonicalKey,
          displayName: entry.agent.name,
          detail: entry.agent.id,
        })),
        unavailable:
          m365Query.isError || m365Query.data?.m365AgentsUnavailable === true,
      },
      orgAgents: {
        options: [
          ...(orgQuery.data?.orgAgents ?? []).map((entry) => ({
            canonicalKey: entry.canonicalKey,
            displayName: entry.agent.name,
            detail: entry.agent.id,
          })),
          ...(orgQuery.data?.staticAgents ?? []).map((entry) => ({
            canonicalKey: entry.canonicalKey,
            displayName: entry.agent.name,
            detail: builtInLabel,
          })),
        ],
        unavailable:
          orgQuery.isError || orgQuery.data?.orgAgentsUnavailable === true,
      },
      guides: {
        options: (guidesQuery.data?.guides ?? []).map((entry) => ({
          canonicalKey: entry.canonicalKey,
          displayName: entry.guide.name,
          detail: entry.guide.id,
        })),
        unavailable: guidesQuery.isError,
      },
      connectors: {
        options: (connectorsQuery.data?.connectors ?? []).map((entry) => ({
          canonicalKey: entry.canonicalKey,
          displayName: entry.connector.name,
          detail: entry.connector.url,
        })),
        unavailable: connectorsQuery.isError,
      },
      datasets: {
        options: (datasetsQuery.data?.datasets ?? []).map((entry) => ({
          canonicalKey: entry.canonicalKey,
          displayName: entry.meta.name,
          detail: entry.meta.id,
        })),
        unavailable: datasetsQuery.isError,
      },
    };
    return DELEGATION_GROUP_ORDER.map((id) => ({
      id,
      options: [...lists[id].options].sort(byName),
      unavailable: lists[id].unavailable,
    }));
  }, [
    rows,
    needAgentQueries,
    builtInLabel,
    agentsQuery.data,
    agentsQuery.isError,
    rulesQuery.data,
    promptQuery.data,
    promptQuery.isError,
    m365Query.data,
    m365Query.isError,
    orgQuery.data,
    orgQuery.isError,
    guidesQuery.data,
    guidesQuery.isError,
    connectorsQuery.data,
    connectorsQuery.isError,
    datasetsQuery.data,
    datasetsQuery.isError,
  ]);

  const nameByKey = useMemo(
    () =>
      new Map(
        groups.flatMap((g) =>
          g.options.map((o) => [o.canonicalKey, o.displayName] as const),
        ),
      ),
    [groups],
  );

  return { groups, nameByKey };
}
