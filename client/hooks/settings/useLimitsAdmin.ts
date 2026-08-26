'use client';

import { useQuery } from '@tanstack/react-query';
import { useFlags } from 'launchdarkly-react-client-sdk';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

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
  /** Present on `?as=` admin previews only. */
  preview?: boolean;
  subject?: string | null;
  /** Override layers the preview cannot evaluate (attribute, group). */
  notEvaluated?: string[];
}

/**
 * The caller's own effective limits. Returns ONLY limits that actually
 * constrain them, so the common case (nothing limited) is an empty list and
 * the UI can render nothing at all rather than a wall of "Unlimited" rows.
 */
export function useMyLimits() {
  const limitsEnabled = useLimitsEnabled();

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

/**
 * True when the `usageLimits` LaunchDarkly flag is on for this user.
 *
 * CLIENT-side only, and deliberately so: it gates UI (the admin rail entry,
 * the limits panel, the /api/limits/me fetch), not security — the limits
 * admin page and API routes keep their own server-side global-admin gates.
 * Outside an LDProvider (or before flags load) `useFlags()` returns no keys,
 * so this fails closed to hidden.
 */
export function useLimitsEnabled(): boolean {
  const { usageLimits } = useFlags();
  return Boolean(usageLimits);
}

/**
 * Global-admin preview of ANOTHER user's effective limits, via
 * `GET /api/limits/me?as=<mail>`. Unlike useMyLimits this returns ALL
 * resolved limits (including unlimited ones) with per-key provenance, so
 * the admin panel can show which override — by id — set each value.
 *
 * `mail === null` disables the query entirely (nothing has been asked yet).
 * A 403 is surfaced as `forbidden` rather than thrown: the limits panel is
 * reachable by admins the preview route may still refuse.
 */
export function useEffectiveLimitsPreview(mail: string | null) {
  const query = useQuery<MyLimitsResponse | { forbidden: true }>({
    queryKey: ['limits-preview', mail],
    enabled: mail !== null && mail.length > 0,
    queryFn: async () => {
      const response = await fetch(
        `/api/limits/me?as=${encodeURIComponent(mail ?? '')}`,
      );
      if (response.status === 403) return { forbidden: true } as const;
      if (!response.ok) {
        throw new Error(`Failed to preview limits: ${response.status}`);
      }
      return unwrapApiData<MyLimitsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  const forbidden = data !== undefined && 'forbidden' in data;
  return {
    result: forbidden || data === undefined ? null : data,
    forbidden,
    isLoading: query.isLoading && query.isFetching,
    error: query.error,
  };
}
