import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { OpenAIModel } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

/** Per-source entry from GET /api/models/sources. */
interface DiscoveredSourceEntry {
  path: string;
  /**
   * Azure region of the source account (best-effort; absent when the ARM
   * lookup failed). Display plumbing rides on the models themselves — each
   * one already carries it as `sourceLocation` — so the entry-level field is
   * only tolerated here, not surfaced separately.
   */
  location?: string;
  models?: OpenAIModel[];
  error?: string;
}

export interface CustomSourceModels {
  /** Discovered models keyed by the source ARM resource path. */
  modelsBySource: Record<string, OpenAIModel[]>;
  /**
   * Per-source discovery failures keyed by resource path. A path the server
   * dropped or omitted entirely (invalid path, prod OBO failure) is reported
   * as 'unreachable' so the UI can distinguish it from a genuinely empty
   * account.
   */
  errorsBySource: Record<string, string>;
  loading: boolean;
  error: string | null;
  /** Refetch with the server-side discovery cache busted. */
  refresh: () => Promise<void>;
}

/**
 * Fetches model deployments for the user's BYO Foundry model sources from
 * /api/models/sources (discovery runs under the user's own OBO ARM token —
 * their RBAC is the authorization). Fetches on mount and whenever the source
 * list changes; no polling. Per-source failures degrade to an empty list on
 * the server, so one broken source never hides the others.
 */
export function useCustomSourceModels(): CustomSourceModels {
  const customModelSources = useSettingsStore((s) => s.customModelSources);
  // Key on the joined paths so edits that don't change any path (rename,
  // selection lists) don't refetch — that filtering is client-side.
  const pathsKey = useMemo(
    () => customModelSources.map((s) => s.resourcePath).join(','),
    [customModelSources],
  );

  const [modelsBySource, setModelsBySource] = useState<
    Record<string, OpenAIModel[]>
  >({});
  const [errorsBySource, setErrorsBySource] = useState<Record<string, string>>(
    {},
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request token: only the latest load() may commit state, so a
  // slow earlier response can't clobber newer results (e.g. disconnect a
  // source, then undo while the narrower fetch is still in flight).
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const seq = ++requestSeqRef.current;
      if (!pathsKey) {
        setModelsBySource({});
        setErrorsBySource({});
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ sources: pathsKey });
        if (refresh) params.set('refresh', '1');
        const response = await fetch(
          `/api/models/sources?${params.toString()}`,
        );
        if (seq !== requestSeqRef.current) return;
        if (!response.ok) {
          throw new Error(`Failed to fetch source models: ${response.status}`);
        }
        const data = await response.json();
        if (seq !== requestSeqRef.current) return;
        const entries: DiscoveredSourceEntry[] = data.sources ?? [];
        const nextModels: Record<string, OpenAIModel[]> = {};
        const nextErrors: Record<string, string> = {};
        for (const entry of entries) {
          nextModels[entry.path] = entry.models ?? [];
          if (entry.error) {
            nextErrors[entry.path] = entry.error;
          }
        }
        // A requested path missing from the response was dropped server-side
        // (invalid path, or prod OBO failure returning no sources at all) —
        // surface it as unreachable rather than silently empty.
        for (const path of pathsKey.split(',')) {
          if (!(path in nextModels)) {
            nextModels[path] = [];
            nextErrors[path] = 'unreachable';
          }
        }
        setModelsBySource(nextModels);
        setErrorsBySource(nextErrors);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : 'fetch_failed');
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [pathsKey],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { modelsBySource, errorsBySource, loading, error, refresh };
}
