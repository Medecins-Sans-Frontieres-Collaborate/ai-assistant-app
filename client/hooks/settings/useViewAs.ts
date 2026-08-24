'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  ViewAsOverrides,
  ViewAsSessionInfo,
} from '@/lib/services/admin/viewAsTypes';

export interface ViewAsStateResponse {
  active: ViewAsSessionInfo | null;
  /** The admin's real values, for the form's "actual" hints. */
  actual: {
    department?: string;
    companyName?: string;
    jobTitle?: string;
    officeId?: string | null;
    region?: 'US' | 'EU';
    mail?: string;
  };
}

/**
 * Admin "view as" state + apply/clear. Both mutations reload the page on
 * success: the overrides live in a cookie the SERVER session callback reads,
 * so every server-rendered surface and every cached query must start over.
 */
export function useViewAs() {
  const queryClient = useQueryClient();

  const query = useQuery<ViewAsStateResponse | null>({
    queryKey: ['admin-view-as'],
    queryFn: async () => {
      const response = await fetch('/api/admin/view-as');
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) {
        throw new Error(`Failed to fetch view-as state: ${response.status}`);
      }
      return unwrapApiData<ViewAsStateResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const apply = useMutation({
    mutationFn: async (overrides: ViewAsOverrides) => {
      const response = await fetch('/api/admin/view-as', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overrides),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.details || body?.error || `Failed (${response.status})`,
        );
      }
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.reload();
    },
  });

  const clear = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/view-as', { method: 'DELETE' });
      if (!response.ok) throw new Error(`Failed (${response.status})`);
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.reload();
    },
  });

  return { query, apply, clear };
}
