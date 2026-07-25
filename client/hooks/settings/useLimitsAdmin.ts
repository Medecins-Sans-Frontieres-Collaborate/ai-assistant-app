'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

/**
 * Server-side LIMITS_ENABLED flag, threaded down from
 * app/[locale]/(chat)/layout.tsx via AppProviders — the same route
 * AgentAccessEnabledContext takes, and for the same reason: NEXT_PUBLIC_
 * vars are inlined at build time, which breaks single-build multi-env
 * deploys. Defaults to false so no query fires unless a server component
 * explicitly enabled the feature.
 */
export const LimitsEnabledContext = createContext<boolean>(false);

export interface MyLimit {
  limitKey: string;
  value: number | boolean | null;
  unit: string;
  window: string;
  source: string;
  overrideId?: string;
  modelId?: string;
  series?: string;
}

export interface MyLimitsResponse {
  enabled: boolean;
  mode?: 'observe' | 'enforce';
  policyUnavailable?: boolean;
  limits: MyLimit[];
}

/**
 * The caller's own effective limits. Returns ONLY limits that actually
 * constrain them, so the common case (nothing limited) is an empty list and
 * the UI can render nothing at all rather than a wall of "Unlimited" rows.
 */
export function useMyLimits() {
  const limitsEnabled = useContext(LimitsEnabledContext);

  const { data, isLoading, error, refetch } = useQuery<MyLimitsResponse | null>(
    {
      queryKey: ['limits-me'],
      enabled: limitsEnabled,
      queryFn: async () => {
        const response = await fetch('/api/limits/me');
        // 401 = signed out; treat as "no limits to show" rather than an error.
        if (response.status === 401) return null;
        if (!response.ok) {
          throw new Error(`Failed to fetch limits: ${response.status}`);
        }
        return unwrapApiData<MyLimitsResponse>(await response.json());
      },
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  );

  return {
    limits: data?.limits ?? [],
    mode: data?.mode ?? 'observe',
    isLimited: (data?.limits ?? []).length > 0,
    isLoading,
    error,
    refetch,
  };
}

/** True when this deployment has limits enabled at all. */
export function useLimitsEnabled(): boolean {
  return useContext(LimitsEnabledContext);
}
