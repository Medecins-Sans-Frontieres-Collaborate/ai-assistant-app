import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { filterAgentsBySourceSelection } from '@/lib/utils/app/agentSourceFilter';

import { useSettingsStore } from '@/client/stores/settingsStore';

/** GET /api/agents — the fast half (app-defined agents). */
interface AppAgentsResponse {
  agents: DiscoveredAgent[];
  /** Static org-agent ids currently overridden or disabled by admin records. */
  suppressedOrgAgentIds?: string[];
}

/** GET /api/agents/foundry — the slow half (Foundry discovery). */
interface FoundryDiscoveryResponse {
  agents: DiscoveredAgent[];
  regionalPath: string | null;
  officePaths: string[];
  /** Nothing could be discovered for this user (OBO failed, …) — retryable. */
  unavailable?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const APP_AGENTS_STALE_MS = 5 * 60 * 1000;

/** Retry with backoff; refetch on focus/reconnect ONLY while errored. */
const resilience = {
  retry: 2,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
  refetchOnReconnect: (query: { state: { status: string } }) =>
    query.state.status === 'error',
} as const;

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

/**
 * Every agent the user can reach, from two independent queries
 * (docs/AGENTS_DISCOVERY_SPLIT_PLAN.md):
 *
 *   ['app-agents']                 /api/agents          fast — prompt, M365,
 *                                                        knowledge agents +
 *                                                        suppressed ids
 *   ['foundry-agents', ...sources] /api/agents/foundry  slow — RBAC-filtered
 *                                                        Foundry discovery
 *
 * Consumers get one merged `foundryAgents` list (name kept for
 * compatibility) as soon as the fast half lands; Foundry rows are appended
 * when discovery completes. `isLoadingFoundryAgents` follows the FAST half
 * (content can be shown), `isDiscoveryLoading` / `isDiscoveryError` the
 * slow one (a footer can say so). A manual refresh busts the caller's
 * server cache for discovery and re-reads the app half.
 */
export function useFoundryAgents() {
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const sourcePaths = customAgentSources.map((s) => s.resourcePath);

  const appQuery = useQuery<AppAgentsResponse>({
    queryKey: ['app-agents'],
    queryFn: ({ signal }) =>
      fetchJson<AppAgentsResponse>('/api/agents', signal),
    // Admin edits to prompt / M365 / knowledge agents should show up
    // without a reload — minutes, not the day-long Foundry window.
    staleTime: APP_AGENTS_STALE_MS,
    gcTime: DAY_MS,
    ...resilience,
  });

  const foundryUrl = (extra?: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (sourcePaths.length > 0) params.set('sources', sourcePaths.join(','));
    const query = params.toString();
    return `/api/agents/foundry${query ? '?' + query : ''}`;
  };

  const foundryQuery = useQuery<FoundryDiscoveryResponse>({
    queryKey: ['foundry-agents', ...sourcePaths],
    queryFn: ({ signal }) =>
      fetchJson<FoundryDiscoveryResponse>(foundryUrl(), signal),
    // Discovery is slow; a good list stays cached for the day and the user
    // can force a refresh. A single transient failure used to strand the
    // query in `error` for the whole session (the hook is mounted
    // permanently, so nothing refetched) — hence the errored-only
    // refetch-on-focus.
    staleTime: DAY_MS,
    gcTime: DAY_MS,
    ...resilience,
    refetchOnWindowFocus: (query) => query.state.status === 'error',
  });

  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAgents = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        // `refresh=1` clears THIS user's server-side discovery cache; seed
        // the React Query cache directly with the fresh response so the
        // hook updates without a second round-trip.
        const fresh = await fetchJson<FoundryDiscoveryResponse>(
          foundryUrl({ refresh: '1' }),
          controller.signal,
        );
        queryClient.setQueryData(['foundry-agents', ...sourcePaths], fresh);
      } catch {
        await queryClient.invalidateQueries({ queryKey: ['foundry-agents'] });
      } finally {
        clearTimeout(timeout);
      }
      await queryClient.invalidateQueries({ queryKey: ['app-agents'] });
    } finally {
      setIsRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, sourcePaths.join(',')]);

  const retry = useCallback(async () => {
    const tasks: Promise<unknown>[] = [];
    if (appQuery.isError) tasks.push(appQuery.refetch());
    if (foundryQuery.isError || foundryQuery.data?.unavailable) {
      tasks.push(foundryQuery.refetch());
    }
    await Promise.all(tasks);
  }, [appQuery, foundryQuery]);

  // Apply per-source agent selection (auto-add toggle + include/exclude
  // lists) at the single choke point every consumer reads from, so the
  // model picker, per-source sections, and counts always agree. Discovery
  // first, app-defined agents after — the order the combined route used.
  const foundryAgents = useMemo(
    () => [
      ...filterAgentsBySourceSelection(
        foundryQuery.data?.agents ?? [],
        customAgentSources,
      ),
      ...(appQuery.data?.agents ?? []),
    ],
    [foundryQuery.data?.agents, appQuery.data?.agents, customAgentSources],
  );

  return {
    foundryAgents,
    suppressedOrgAgentIds: appQuery.data?.suppressedOrgAgentIds ?? [],
    regionalPath: foundryQuery.data?.regionalPath ?? null,
    officePaths: foundryQuery.data?.officePaths ?? [],
    /** The FAST half is still loading (nothing to show yet). */
    isLoadingFoundryAgents: appQuery.isLoading || isRefreshing,
    isRefreshingFoundryAgents: isRefreshing,
    /** Foundry discovery still running (rows will be appended). */
    isDiscoveryLoading: foundryQuery.isLoading || isRefreshing,
    /** Foundry discovery failed with nothing cached, or was unavailable. */
    isDiscoveryError:
      (foundryQuery.isError && foundryQuery.data === undefined) ||
      foundryQuery.data?.unavailable === true,
    /** The fast half failed and nothing is cached — see useAgentBrowserAvailability. */
    isFoundryAgentsError: appQuery.isError && appQuery.data === undefined,
    foundryAgentsError: appQuery.error ?? foundryQuery.error,
    refetchFoundryAgents: refreshAgents,
    /** Plain refetch of whichever half failed (no server-cache bust). */
    retryFoundryAgents: retry,
  };
}
