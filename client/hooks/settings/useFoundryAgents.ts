import { useQuery } from '@tanstack/react-query';

import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

interface FoundryAgentsResponse {
  agents: DiscoveredAgent[];
}

/**
 * Hook to fetch dynamically discovered Foundry agents from the /api/agents endpoint.
 * Results are RBAC-filtered per user — only agents they have access to are returned.
 *
 * Uses React Query with a 5-minute stale time to match the server-side cache TTL.
 * Returns empty array on error (graceful degradation — static RAG agents still work).
 */
export function useFoundryAgents() {
  const {
    data,
    isLoading: isLoadingFoundryAgents,
    error: foundryAgentsError,
  } = useQuery<FoundryAgentsResponse>({
    queryKey: ['foundry-agents'],
    queryFn: async () => {
      const response = await fetch('/api/agents');
      if (!response.ok) {
        throw new Error(`Failed to fetch agents: ${response.status}`);
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — matches server cache TTL
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return {
    foundryAgents: data?.agents ?? [],
    isLoadingFoundryAgents,
    foundryAgentsError,
  };
}
