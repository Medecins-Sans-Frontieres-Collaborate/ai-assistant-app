'use client';

import { useQuery } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

interface GrantsAccessResponse {
  hasAccess: boolean;
}

/**
 * Whether the signed-in user is in the grants Entra group, from
 * /api/grants/access.
 */
export function useGrantsAccess() {
  const { data, isLoading } = useQuery<GrantsAccessResponse | null>({
    queryKey: ['grants-access'],
    queryFn: async () => {
      const response = await fetch('/api/grants/access');
      if (response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Failed to fetch grants access: ${response.status}`);
      }
      return unwrapApiData<GrantsAccessResponse>(await response.json());
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return { hasGrantsAccess: data?.hasAccess ?? false, isLoading };
}
