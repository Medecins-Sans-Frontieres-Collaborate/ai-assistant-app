'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { LIMITS_CHANGED_EVENT } from '@/client/hooks/settings/limitsUxEvents';

import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import { ModelListSource, OpenAIModel, OpenAIModelID } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { getDefaultModel } from '@/config/models';

export const MODELS_QUERY_KEY = ['models'] as const;

interface ModelsQueryData {
  models: OpenAIModel[];
  source: ModelListSource | null;
}

/**
 * Applies a discovered list to the settings store — the body of the old
 * AppInitializer step 4, moved here verbatim so a REFETCH (window focus,
 * limits change) re-runs the same default-model repair a page load does.
 */
function applyDiscoveredModels({
  models: discovered,
  source,
}: ModelsQueryData) {
  const { setModels, setDefaultModelId } = useSettingsStore.getState();
  setModels(discovered);
  useSettingsStore.getState().setModelListSource(source);

  // The persisted defaultModelId may no longer exist in the
  // discovered list (region change, deployment removed, ring
  // gate), or may exist but not be selectable there. Re-resolve the
  // env default among SELECTABLE models only — discovered[0] can
  // be a foreign-region-only model (e.g. EU-only for a US user),
  // and defaulting onto it would break new conversations.
  const region = useSettingsStore.getState().userRegion;
  const selectable = discovered.filter((m) =>
    isModelSelectableInRegion(m, region),
  );
  const currentDefaultId = useSettingsStore.getState().defaultModelId;
  const stillPresent =
    currentDefaultId && selectable.some((m) => m.id === currentDefaultId);
  if (!stillPresent) {
    // Resolve against the selectable DISCOVERED models so the
    // default tracks deployments (latest deployed standard GPT).
    const envDefaultModelId = getDefaultModel(selectable);
    const newDefault =
      selectable.find((m) => m.id === envDefaultModelId) || selectable[0];
    if (newDefault) {
      console.log(
        `[AppInitializer] Persisted defaultModelId "${currentDefaultId}" not selectable in discovered list. Re-selecting default: ${newDefault.id}`,
      );
      setDefaultModelId(newDefault.id as OpenAIModelID);
    }
  }
}

/**
 * The live model list as a React Query (`['models']`), replacing the
 * run-once fetch in AppInitializer step 4. Mount ONCE (AppInitializer does);
 * the store, not the query result, is what pickers read.
 *
 * Why a query and not an effect: the server hides models the caller is
 * blocked from, so the list is stale the moment an admin saves a policy in
 * the same tab (docs/LIMITS_USER_FACING_UX.md §1b). A query can be
 * invalidated — by the `limits:changed` window event below and by window
 * focus — where the one-shot effect could only be reloaded.
 *
 * Failure posture is unchanged: any error keeps whatever the store holds
 * (the static seed from step 1, or the last good discovered list).
 */
export function useModelsQuery() {
  const queryClient = useQueryClient();

  const query = useQuery<ModelsQueryData | null>({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/models');
      if (!res.ok) {
        throw new Error(`Failed to fetch models: ${res.status}`);
      }
      const json = await res.json();
      // `json?.data?.models` is intentionally guarded by the Array.isArray
      // check below — an unexpected shape simply leaves the static list.
      const discovered = json?.data?.models as OpenAIModel[] | undefined;
      if (!Array.isArray(discovered) || discovered.length === 0) return null;
      return {
        models: discovered,
        source: (json?.data?.source as ModelListSource | undefined) ?? null,
      };
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });

  // Structural sharing keeps `data` referentially stable across refetches
  // that return the same list, so this only re-applies on a real change.
  const { data, error } = query;
  useEffect(() => {
    if (!data) return;
    try {
      applyDiscoveredModels(data);
    } catch (e) {
      console.warn(
        '[AppInitializer] /api/models refine failed; keeping static list',
        e,
      );
    }
  }, [data]);

  useEffect(() => {
    if (!error) return;
    console.warn(
      '[AppInitializer] /api/models refine failed; keeping static list',
      error,
    );
  }, [error]);

  // Anything that learns a limit moved (admin save, quota 403) fires this;
  // both the served list and the per-model verdicts must be re-read.
  useEffect(() => {
    const onLimitsChanged = () => {
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['limits-me'] });
    };
    window.addEventListener(LIMITS_CHANGED_EVENT, onLimitsChanged);
    return () => {
      window.removeEventListener(LIMITS_CHANGED_EVENT, onLimitsChanged);
    };
  }, [queryClient]);

  return query;
}
