import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface FoundryAgentsResponse {
  agents: DiscoveredAgent[];
  regionalPath: string | null;
  officePaths: string[];
}

/**
 * Hook to fetch dynamically discovered Foundry agents from the /api/agents endpoint.
 * Results are RBAC-filtered per user — only agents they have access to are returned.
 *
 * Includes agents from both default org sources (EU/US) and user-configured
 * custom agent sources. Custom sources are passed as a query parameter.
 *
 * Uses React Query with a 24-hour stale time; the list rarely changes within a
 * session and the user can force a refresh manually.
 * Returns empty array on error (graceful degradation — static RAG agents still work).
 */
export function useFoundryAgents() {
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const sourcePaths = customAgentSources.map((s) => s.resourcePath);

  const {
    data,
    isLoading: isLoadingFoundryAgents,
    error: foundryAgentsError,
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
    staleTime: 24 * 60 * 60 * 1000, // 24 hours — user can manually refresh
    gcTime: 24 * 60 * 60 * 1000, // 24 hours — persist cache across modal open/close
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAgents = useCallback(async () => {
    setIsRefreshing(true);
    try {
      // Bust the server-side discovery cache and refetch in a single round-trip.
      // We mark the cached query stale (via a one-shot `refresh=1` query key
      // adjustment isn't possible in TanStack Query — so we rely on the route's
      // `refresh` query param to clear the server cache) then invalidate, which
      // triggers React Query's normal fetch path against the unparameterized URL.
      const params = new URLSearchParams();
      if (sourcePaths.length > 0) {
        params.set('sources', sourcePaths.join(','));
      }
      params.set('refresh', '1');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`/api/agents?${params.toString()}`, {
          signal: controller.signal,
        });
        if (response.ok) {
          // Seed the React Query cache directly with the fresh response so
          // the hook's data updates without issuing a second network request.
          const fresh = await response.json();
          queryClient.setQueryData(['foundry-agents', ...sourcePaths], fresh);
        } else {
          // Fallback: invalidate and let the query refetch.
          await queryClient.invalidateQueries({
            queryKey: ['foundry-agents'],
          });
        }
      } catch {
        await queryClient.invalidateQueries({ queryKey: ['foundry-agents'] });
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient, sourcePaths]);

  return {
    foundryAgents: isRefreshing ? [] : (data?.agents ?? []),
    regionalPath: data?.regionalPath ?? null,
    officePaths: data?.officePaths ?? [],
    isLoadingFoundryAgents: isLoadingFoundryAgents || isRefreshing,
    foundryAgentsError,
    refetchFoundryAgents: refreshAgents,
  };
}
