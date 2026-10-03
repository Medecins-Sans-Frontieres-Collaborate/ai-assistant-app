'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import type { AssessorModelOption } from '@/lib/services/webSearch/config/assessorModels';
import {
  MULTI_STEP_BOUNDS,
  MultiStepSettings,
  ResolvedMultiStepConfig,
  WebSearchConfig,
} from '@/lib/services/webSearch/config/types';

export interface WebSearchConfigResponse {
  config: WebSearchConfig | null;
  etag: string | null;
  configUnavailable: boolean;
  /** Code fallbacks, bounds and assessor choices — served, not duplicated. */
  defaults: ResolvedMultiStepConfig;
  bounds: typeof MULTI_STEP_BOUNDS;
  assessorModels: AssessorModelOption[];
  assessorFallbackModelId: string;
}

export class WebSearchConfigConflict extends Error {
  constructor() {
    super('conflict');
    this.name = 'WebSearchConfigConflict';
  }
}

/** Admin read + CAS write of the web search config (global admins only). */
export function useWebSearchConfigAdmin() {
  const queryClient = useQueryClient();

  const query = useQuery<WebSearchConfigResponse>({
    queryKey: ['web-search-config'],
    queryFn: async () => {
      const response = await fetch('/api/admin/web-search');
      if (!response.ok) {
        throw new Error(
          `Failed to fetch web search config: ${response.status}`,
        );
      }
      return unwrapApiData<WebSearchConfigResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (input: {
      multiStep: MultiStepSettings;
      etag: string | null;
    }) => {
      const response = await fetch('/api/admin/web-search', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(input.etag ? { 'if-match': input.etag } : {}),
        },
        body: JSON.stringify({ multiStep: input.multiStep }),
      });
      if (response.status === 409) throw new WebSearchConfigConflict();
      if (!response.ok) {
        throw new Error(`Failed to save web search config: ${response.status}`);
      }
      return unwrapApiData<{ config: WebSearchConfig; etag: string }>(
        await response.json(),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['web-search-config'] });
    },
  });

  return { query, save };
}
