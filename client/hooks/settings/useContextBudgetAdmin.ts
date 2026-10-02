'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  CONTEXT_BUDGET_BOUNDS,
  ContextBudgetConfig,
  ContextBudgetSettings,
  ResolvedContextBudgetConfig,
} from '@/lib/services/contextBudget/types';

export interface ContextBudgetCatalogModel {
  id: string;
  name: string;
  series?: string;
  maxLength: number;
  tokenLimit: number;
}

export interface ContextBudgetConfigResponse {
  config: ContextBudgetConfig | null;
  etag: string | null;
  configUnavailable: boolean;
  /** Code fallbacks, bounds and the catalog — served, not duplicated. */
  defaults: ResolvedContextBudgetConfig;
  bounds: typeof CONTEXT_BUDGET_BOUNDS;
  families: Array<{ id: string; label: string }>;
  models: ContextBudgetCatalogModel[];
}

export class ContextBudgetConfigConflict extends Error {
  constructor() {
    super('conflict');
    this.name = 'ContextBudgetConfigConflict';
  }
}

/** Admin read + CAS write of the context budget (global admins only). */
export function useContextBudgetAdmin() {
  const queryClient = useQueryClient();

  const query = useQuery<ContextBudgetConfigResponse>({
    queryKey: ['context-budget-config'],
    queryFn: async () => {
      const response = await fetch('/api/admin/context-budget');
      if (!response.ok) {
        throw new Error(`Failed to fetch context budget: ${response.status}`);
      }
      return unwrapApiData<ContextBudgetConfigResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (input: {
      budget: ContextBudgetSettings;
      etag: string | null;
    }) => {
      const response = await fetch('/api/admin/context-budget', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(input.etag ? { 'if-match': input.etag } : {}),
        },
        body: JSON.stringify({ budget: input.budget }),
      });
      if (response.status === 409) throw new ContextBudgetConfigConflict();
      if (!response.ok) {
        throw new Error(`Failed to save context budget: ${response.status}`);
      }
      return unwrapApiData<{ config: ContextBudgetConfig; etag: string }>(
        await response.json(),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['context-budget-config'] });
    },
  });

  return { query, save };
}
