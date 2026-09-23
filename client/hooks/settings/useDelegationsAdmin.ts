'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { DelegationsDocument } from '@/lib/services/delegations/types';
import { WriteSharedDelegation } from '@/lib/services/delegations/writeSchema';

export interface DelegationsResponse {
  document: DelegationsDocument | null;
  etag: string | null;
  unavailable: boolean;
}

export class DelegationsSaveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'DelegationsSaveError';
  }
}

/** Admin read + CAS write of the shared delegations (global admins only). */
export function useDelegationsAdmin() {
  const queryClient = useQueryClient();

  const query = useQuery<DelegationsResponse>({
    queryKey: ['admin-delegations'],
    queryFn: async () => {
      const response = await fetch('/api/admin/delegations');
      if (!response.ok) {
        throw new Error(`Failed to fetch delegations: ${response.status}`);
      }
      return unwrapApiData<DelegationsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (input: {
      delegations: WriteSharedDelegation[];
      etag: string;
    }) => {
      const response = await fetch('/api/admin/delegations', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': input.etag },
        body: JSON.stringify({ delegations: input.delegations }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new DelegationsSaveError(
          response.status,
          body?.code,
          body?.error ?? body?.message ?? 'Save failed',
          body?.details,
        );
      }
      return unwrapApiData<{ document: DelegationsDocument; etag: string }>(
        await response.json(),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-delegations'] });
      // The limits editor composes these on read.
      queryClient.invalidateQueries({ queryKey: ['limits-scoped'] });
    },
  });

  return { query, save };
}
