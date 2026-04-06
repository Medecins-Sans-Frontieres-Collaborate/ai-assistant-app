import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface FoundryAgentsResponse {
  agents: DiscoveredAgent[];
}

/**
 * Hook to fetch dynamically discovered Foundry agents from the /api/agents endpoint.
 * Results are RBAC-filtered per user — only agents they have access to are returned.
 *
 * Includes agents from both default org sources (EU/US) and user-configured
 * custom agent sources. Custom sources are passed as a query parameter.
 *
 * Uses React Query with a 5-minute stale time to match the server-side cache TTL.
 * Returns empty array on error (graceful degradation — static RAG agents still work).
 */
export function useFoundryAgents() {
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const sourcePaths = customAgentSources.map((s) => s.resourcePath);

  const {
    data,
    isLoading: isLoadingFoundryAgents,
    error: foundryAgentsError,
    refetch: refetchFoundryAgents,
  } = useQuery<FoundryAgentsResponse>({
    queryKey: ['foundry-agents', ...sourcePaths],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sourcePaths.length > 0) {
        params.set('sources', sourcePaths.join(','));
      }
      const url = `/api/agents${params.toString() ? '?' + params.toString() : ''}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch agents: ${response.status}`);
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — matches server cache TTL
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAgents = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (sourcePaths.length > 0) {
        params.set('sources', sourcePaths.join(','));
      }
      params.set('refresh', '1');
      // 15s timeout to prevent UI getting stuck
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        await fetch(`/api/agents?${params.toString()}`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      await queryClient.invalidateQueries({ queryKey: ['foundry-agents'] });
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient, sourcePaths]);

  return {
    foundryAgents: isRefreshing ? [] : (data?.agents ?? []),
    isLoadingFoundryAgents: isLoadingFoundryAgents || isRefreshing,
    foundryAgentsError,
    refetchFoundryAgents: refreshAgents,
  };
}
