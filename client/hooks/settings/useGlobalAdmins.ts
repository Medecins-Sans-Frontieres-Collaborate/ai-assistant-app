'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { GlobalAdminRoster } from '@/lib/services/admin/globalAdminsTypes';

/** Shape of GET /api/admin/global-admins (app/api/admin/global-admins/route.ts). */
export interface GlobalAdminsResponse {
  /** null = no roster authored yet (env admins only). */
  roster: GlobalAdminRoster | null;
  etag: string | null;
  /** The env `AGENT_ACCESS_ADMINS` bootstrap roster — read-only here. */
  envAdmins: string[];
}

/** 409 GLOBAL_ADMINS_CONFLICT — another admin saved first; reload and retry. */
export class GlobalAdminsConflict extends Error {
  constructor() {
    super('conflict');
    this.name = 'GlobalAdminsConflict';
  }
}

/**
 * 400 GLOBAL_ADMINS_LOCKOUT — the save would leave BOTH rosters empty. The
 * server is the authority; the panel also predicts it so Save is disabled
 * before the round-trip.
 */
export class GlobalAdminsLockout extends Error {
  constructor() {
    super('lockout');
    this.name = 'GlobalAdminsLockout';
  }
}

export const GLOBAL_ADMINS_QUERY_KEY = ['admin-global-admins'] as const;

/**
 * Admin read + CAS write of the config-based global admin roster
 * (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §13). Same contract as
 * useWorkflowPolicyAdmin: the PUT carries the ETag from the last GET as
 * `If-Match` (absent when no roster exists yet = create-only), a 412 on the
 * blob surfaces as 409 and is thrown as `GlobalAdminsConflict` so the panel
 * can toast and refetch rather than silently overwrite another admin's save.
 */
export function useGlobalAdmins() {
  const queryClient = useQueryClient();

  const query = useQuery<GlobalAdminsResponse>({
    queryKey: GLOBAL_ADMINS_QUERY_KEY,
    queryFn: async () => {
      const response = await fetch('/api/admin/global-admins');
      if (!response.ok) {
        throw new Error(`Failed to fetch global admins: ${response.status}`);
      }
      return unwrapApiData<GlobalAdminsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (input: { admins: string[]; etag: string | null }) => {
      const response = await fetch('/api/admin/global-admins', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(input.etag ? { 'if-match': input.etag } : {}),
        },
        body: JSON.stringify({ admins: input.admins }),
      });
      if (response.status === 409) throw new GlobalAdminsConflict();
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
          error?: string;
          details?: string;
        } | null;
        if (body?.code === 'GLOBAL_ADMINS_LOCKOUT') {
          throw new GlobalAdminsLockout();
        }
        throw new Error(
          body?.details ||
            body?.error ||
            `Failed to save global admins: ${response.status}`,
        );
      }
      return unwrapApiData<{ etag: string }>(await response.json());
    },
    onSettled: () => {
      // The rail (/api/admin/areas) and every isGlobalAdmin gate follow the
      // roster; a saved change should not wait 5 minutes to reach the nav.
      queryClient.invalidateQueries({ queryKey: GLOBAL_ADMINS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['admin-areas'] });
    },
  });

  return { query, save };
}
