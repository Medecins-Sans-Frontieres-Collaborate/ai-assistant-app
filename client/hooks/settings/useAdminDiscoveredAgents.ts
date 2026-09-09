'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type {
  AgentsApiResponse,
  DiscoveredAgentSummary,
} from '@/components/AgentAccess/types';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface FoundryDiscoveryResponse {
  agents: DiscoveredAgentSummary[];
  unavailable?: boolean;
}

interface UseAdminDiscoveredAgentsOptions {
  /** Pass false to skip both fetches (callers that receive rows instead). */
  enabled?: boolean;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

/**
 * Every agent an admin can write rules for, in the shape the pre-split
 * `/api/agents` served: Foundry discoveries first, app-defined agents
 * (prompt, M365, org) after.
 *
 * Agent discovery is split across two routes (docs/AGENTS_DISCOVERY_SPLIT_PLAN.md):
 * `/api/agents` is the fast app half and IGNORES `sources`; Foundry rows —
 * including the admin's own custom sources — come from `/api/agents/foundry`.
 * Admin surfaces must read both, so this hook fetches both and merges.
 * Unlike `useFoundryAgents` it applies no per-source selection filtering:
 * agents hidden from the picker are still manageable here.
 *
 * `isError` follows the app half only. A Foundry failure leaves the app rows
 * usable and is reported separately as `isFoundryUnavailable` (also true when
 * the route answers `unavailable`, e.g. OBO failed).
 */
export function useAdminDiscoveredAgents({
  enabled = true,
}: UseAdminDiscoveredAgentsOptions = {}) {
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const sourcePaths = customAgentSources.map((s) => s.resourcePath);
  const listQuery = {
    staleTime: 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
    enabled,
  } as const;

  const appQuery = useQuery<AgentsApiResponse>({
    queryKey: ['agent-access-admin-agents'],
    queryFn: () => fetchJson<AgentsApiResponse>('/api/agents'),
    ...listQuery,
  });

  const foundryQuery = useQuery<FoundryDiscoveryResponse>({
    queryKey: ['agent-access-admin-foundry-agents', ...sourcePaths],
    queryFn: () => {
      const params = new URLSearchParams();
      if (sourcePaths.length > 0) params.set('sources', sourcePaths.join(','));
      const query = params.toString();
      return fetchJson<FoundryDiscoveryResponse>(
        `/api/agents/foundry${query ? '?' + query : ''}`,
      );
    },
    ...listQuery,
  });

  const data = useMemo<AgentsApiResponse | undefined>(() => {
    if (!appQuery.data && !foundryQuery.data) return undefined;
    return {
      agents: [
        ...(foundryQuery.data?.agents ?? []),
        ...(appQuery.data?.agents ?? []),
      ],
    };
  }, [appQuery.data, foundryQuery.data]);

  return {
    data,
    isLoading: appQuery.isLoading || foundryQuery.isLoading,
    isError: appQuery.isError,
    isFoundryUnavailable:
      foundryQuery.isError || foundryQuery.data?.unavailable === true,
  };
}
