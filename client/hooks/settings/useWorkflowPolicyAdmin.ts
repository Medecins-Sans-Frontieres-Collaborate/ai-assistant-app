'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { WorkflowPolicy } from '@/lib/services/workflows/policy/types';

import { ConversationWorkflowType } from '@/types/workflow';

export interface WorkflowPolicyResponse {
  policy: WorkflowPolicy | null;
  etag: string | null;
  policyUnavailable: boolean;
}

export class WorkflowPolicyConflict extends Error {
  constructor() {
    super('conflict');
    this.name = 'WorkflowPolicyConflict';
  }
}

/** Admin read + CAS write of the workflow policy (global admins only). */
export function useWorkflowPolicyAdmin() {
  const queryClient = useQueryClient();

  const query = useQuery<WorkflowPolicyResponse>({
    queryKey: ['workflow-policy'],
    queryFn: async () => {
      const response = await fetch('/api/workflows/policy');
      if (!response.ok) {
        throw new Error(`Failed to fetch workflow policy: ${response.status}`);
      }
      return unwrapApiData<WorkflowPolicyResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (input: {
      workflows: Record<ConversationWorkflowType, { enabled: boolean }>;
      etag: string | null;
    }) => {
      const response = await fetch('/api/workflows/policy', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(input.etag ? { 'if-match': input.etag } : {}),
        },
        body: JSON.stringify({ workflows: input.workflows }),
      });
      if (response.status === 409) throw new WorkflowPolicyConflict();
      if (!response.ok) {
        throw new Error(`Failed to save workflow policy: ${response.status}`);
      }
      return unwrapApiData<{ policy: WorkflowPolicy; etag: string }>(
        await response.json(),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-policy'] });
      queryClient.invalidateQueries({ queryKey: ['workflow-policy-me'] });
    },
  });

  return { query, save };
}
