'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';

import type { ALL_AGENT_KEYS } from '@/lib/services/agentAccess/adminAuth';

/**
 * Server-side AGENT_ACCESS_CONTROL_ENABLED flag, threaded down from
 * app/[locale]/(chat)/layout.tsx via AppProviders (the same way
 * launchDarklyClientId travels). Deliberately NOT a NEXT_PUBLIC_ var:
 * those are inlined at build time, which breaks single-build multi-env
 * deploys. Defaults to false so the /me query never fires unless a server
 * component explicitly enabled the feature.
 */
export const AgentAccessEnabledContext = createContext<boolean>(false);

/**
 * Response of GET /api/agent-access/me (see docs/AGENT_ACCESS_CONTROL.md).
 * `editableAgentKeys` is '*' for global admins, otherwise the canonical
 * agent keys delegated to this local admin (empty for non-admins).
 */
export interface AgentAccessMe {
  isGlobalAdmin: boolean;
  isLocalAdmin: boolean;
  editableAgentKeys: typeof ALL_AGENT_KEYS | string[];
}

/**
 * Unwraps the standard `{ success, data }` envelope from
 * lib/utils/server/api/apiResponse.ts while tolerating a bare payload.
 */
export function unwrapApiData<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/**
 * Fetches the current user's agent-access admin status. When the feature is
 * disabled (AgentAccessEnabledContext false) NO request fires at all and the
 * hook reports me=null / isAdmin=false; a 401 (signed out) also resolves to
 * null rather than an error.
 *
 * The result only drives UI visibility (sidebar link, admin panel) — the
 * server component + API routes are the real gate.
 */
export function useAgentAccessAdmin() {
  const agentAccessEnabled = useContext(AgentAccessEnabledContext);

  const { data, isLoading, error, refetch } = useQuery<AgentAccessMe | null>({
    queryKey: ['agent-access-me'],
    enabled: agentAccessEnabled,
    queryFn: async () => {
      const response = await fetch('/api/agent-access/me');
      // 404 = feature disabled; 401 = signed out. Both mean "not an admin"
      // rather than an error worth surfacing.
      if (response.status === 404 || response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Failed to fetch admin status: ${response.status}`);
      }
      return unwrapApiData<AgentAccessMe>(await response.json());
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const me = data ?? null;
  return {
    me,
    isAdmin: me !== null && (me.isGlobalAdmin || me.isLocalAdmin),
    isGlobalAdmin: me?.isGlobalAdmin ?? false,
    isLoading,
    error,
    refetch,
  };
}
