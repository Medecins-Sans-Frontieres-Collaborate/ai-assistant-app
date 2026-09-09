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

/**
 * The app half answers from memory in tens of milliseconds; anything slower
 * is an upstream that has stopped answering, so fail fast and let the retry
 * take over. Discovery talks to ARM/Foundry and is genuinely seconds cold,
 * so it gets its own, longer budget — one number for both would either
 * strand the picker on a hung `/api/agents` or kill a healthy cold discovery.
 */
const APP_AGENTS_TIMEOUT_MS = 15000;
const FOUNDRY_TIMEOUT_MS = 30000;

/**
 * Retry with backoff; refetch on focus/reconnect ONLY while errored.
 *
 * Both halves need the errored-only focus refetch: the shared QueryClient
 * sets `refetchOnWindowFocus: false` globally, and this hook is mounted for
 * the life of the page (Sidebar, AgentChip, ConnectorPinTray), so
 * `refetchOnMount` never fires a second time either. Without the override a
 * single transient failure strands the query in `error` for the whole
 * session — the org agents just stay missing until the user reloads.
 */
const resilience = {
  retry: 2,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
  refetchOnReconnect: (query: { state: { status: string } }) =>
    query.state.status === 'error',
  refetchOnWindowFocus: (query: { state: { status: string } }) =>
    query.state.status === 'error',
} as const;

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  // Two independent aborts have to stay independent: React Query owns
  // `signal` (unmount / cancelled refetch) and we own the timeout.
  // AbortSignal.any keeps both live and adopts the reason of whichever
  // fired first, which is what lets them be told apart in the catch.
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const response = await fetch(url, { signal: composed });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    // A timeout must surface as an ordinary Error, never as an abort:
    // everything downstream (and the rest of this codebase) reads
    // `name === 'AbortError'` as "the caller cancelled on purpose", and a
    // silently swallowed failure is exactly the eternal spinner this
    // replaces. React Query's own cancellation never reaches the retry
    // logic — `cancel()` rejects the retryer with a CancelledError first and
    // drops whatever the queryFn throws afterwards — so relabelling here
    // cannot turn a cancellation into a spurious error state, while a plain
    // Error is retried by `retry` above like any other failure.
    // A caller abort that raced the timeout stays a caller abort.
    if (timeout.aborted && !signal?.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms fetching ${url}`);
    }
    throw error;
  }
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
 *
 * Failure contract: neither half may fail permanently. Every request is
 * time-boxed (a hung upstream becomes a retryable error, not a spinner that
 * never stops), retried with backoff, and — because this hook stays mounted
 * for the life of the page — re-attempted on the next window focus or
 * reconnect while, and only while, it is in `error`. Callers that render the
 * list still have to show `isFoundryAgentsError` / `isDiscoveryError` with a
 * `retryFoundryAgents` affordance: recovery is best-effort, not a guarantee.
 */
export function useFoundryAgents() {
  const customAgentSources = useSettingsStore((s) => s.customAgentSources);
  const sourcePaths = customAgentSources.map((s) => s.resourcePath);

  const appQuery = useQuery<AppAgentsResponse>({
    queryKey: ['app-agents'],
    queryFn: ({ signal }) =>
      fetchJson<AppAgentsResponse>(
        '/api/agents',
        APP_AGENTS_TIMEOUT_MS,
        signal,
      ),
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
      fetchJson<FoundryDiscoveryResponse>(
        foundryUrl(),
        FOUNDRY_TIMEOUT_MS,
        signal,
      ),
    // Discovery is slow; a good list stays cached for the day and the user
    // can force a refresh. Recovery from a transient failure comes from
    // `resilience` (errored-only refetch on focus/reconnect).
    staleTime: DAY_MS,
    gcTime: DAY_MS,
    ...resilience,
  });

  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshAgents = useCallback(async () => {
    setIsRefreshing(true);
    try {
      try {
        // `refresh=1` clears THIS user's server-side discovery cache; seed
        // the React Query cache directly with the fresh response so the
        // hook updates without a second round-trip. It is the cold-discovery
        // path by construction, so it takes the discovery budget rather than
        // a second, shorter number of its own.
        const fresh = await fetchJson<FoundryDiscoveryResponse>(
          foundryUrl({ refresh: '1' }),
          FOUNDRY_TIMEOUT_MS,
        );
        queryClient.setQueryData(['foundry-agents', ...sourcePaths], fresh);
      } catch {
        await queryClient.invalidateQueries({ queryKey: ['foundry-agents'] });
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
