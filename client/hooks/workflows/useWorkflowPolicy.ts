'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { WORKFLOW_POLICY_DEFAULTS } from '@/lib/services/workflows/policy/types';

import { ConversationWorkflowType } from '@/types/workflow';

interface WorkflowPolicyMeResponse {
  enabled: Record<ConversationWorkflowType, boolean>;
  policyUnavailable: boolean;
}

/**
 * Which workflows the admin policy currently allows, for menu/tab visibility
 * and the "disabled by an administrator" notice. Visibility only — every
 * workflow API route re-checks the policy server-side.
 *
 * While loading (or signed out / on error) the compiled DEFAULTS apply, which
 * are the same defaults the server uses with no policy: the general
 * workflows show, grants does not. So a slow fetch can never flash a
 * restricted workflow into a menu.
 */
export function useWorkflowPolicy() {
  const { data, isLoading } = useQuery<WorkflowPolicyMeResponse | null>({
    queryKey: ['workflow-policy-me'],
    queryFn: async () => {
      const response = await fetch('/api/workflows/policy/me');
      if (response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Failed to fetch workflow policy: ${response.status}`);
      }
      return unwrapApiData<WorkflowPolicyMeResponse>(await response.json());
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const enabled = data?.enabled;
  const isWorkflowEnabled = useCallback(
    (type: ConversationWorkflowType): boolean =>
      enabled?.[type] ?? WORKFLOW_POLICY_DEFAULTS[type],
    [enabled],
  );

  return { isWorkflowEnabled, isLoading };
}
