'use client';

import { useQuery } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

interface AdminAreasResponse {
  areas: AdminAreaId[];
  configUnavailable: boolean;
}

/**
 * Which admin areas the current user may open.
 *
 * Unconditionally enabled, unlike `useAgentAccessAdmin` — that hook's query is
 * gated on AgentAccessEnabledContext, so deriving admin-ness from it hid the
 * admin entry entirely on any deployment running usage limits with agent
 * access switched off. The server resolves the two independent env flags.
 *
 * Visibility only; every admin page has its own server-side gate.
 */
export function useAdminAreas() {
  const { data, isLoading } = useQuery<AdminAreasResponse | null>({
    queryKey: ['admin-areas'],
    queryFn: async () => {
      const response = await fetch('/api/admin/areas');
      // Signed out — not an error worth surfacing in a nav menu.
      if (response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Failed to fetch admin areas: ${response.status}`);
      }
      return unwrapApiData<AdminAreasResponse>(await response.json());
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return {
    areas: data?.areas ?? [],
    isAdmin: (data?.areas ?? []).length > 0,
    configUnavailable: data?.configUnavailable ?? false,
    isLoading,
  };
}
