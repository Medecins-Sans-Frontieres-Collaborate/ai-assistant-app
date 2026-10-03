'use client';

import { useQuery } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  AnalyticsAccessResponse,
  AnalyticsDashboardResponse,
  AnalyticsFilesResponse,
  AnalyticsPreviewResponse,
  AnalyticsTableResponse,
  AnalyticsTreeResponse,
  AnalyticsTrendResponse,
} from '@/lib/services/analytics/dto';

async function getJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${what}: ${response.status}`);
  }
  return unwrapApiData<T>(await response.json());
}

/**
 * Whether the navigation should offer /analytics to this person.
 *
 * There is no rollout flag: the server's deny-by-default folder access is
 * the gate. Until an admin names someone in a folder audience this answers
 * false for them, so the surfaces stay hidden without a client-side switch.
 */
export function useAnalyticsAccess() {
  const { data } = useQuery<AnalyticsAccessResponse | null>({
    queryKey: ['analytics-access'],
    queryFn: async () => {
      const response = await fetch('/api/analytics/access');
      // Signed out — not an error worth surfacing in a nav menu.
      if (response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Failed to fetch analytics access: ${response.status}`);
      }
      return unwrapApiData<AnalyticsAccessResponse>(await response.json());
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return {
    hasAccess: data?.hasAccess ?? false,
    canAdmin: data?.canAdmin ?? false,
  };
}

export function useAnalyticsTree() {
  return useQuery<AnalyticsTreeResponse>({
    queryKey: ['analytics-tree'],
    queryFn: () =>
      getJson<AnalyticsTreeResponse>(
        '/api/analytics/tree',
        'analytics folders',
      ),
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useAnalyticsFiles(folder: string | null) {
  return useQuery<AnalyticsFilesResponse>({
    queryKey: ['analytics-files', folder],
    queryFn: () =>
      getJson<AnalyticsFilesResponse>(
        `/api/analytics/files?folder=${encodeURIComponent(folder ?? '')}`,
        'analytics files',
      ),
    enabled: folder !== null,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** The tables of one file — names and sizes, no rows. */
export function useAnalyticsPreview(fileId: string | null) {
  return useQuery<AnalyticsPreviewResponse>({
    queryKey: ['analytics-preview', fileId],
    queryFn: () =>
      getJson<AnalyticsPreviewResponse>(
        `/api/analytics/preview?id=${encodeURIComponent(fileId ?? '')}`,
        'the preview',
      ),
    enabled: fileId !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** One table's rows, already filtered for this person by the server. */
export function useAnalyticsTable(fileId: string, table: string | null) {
  return useQuery<AnalyticsTableResponse>({
    queryKey: ['analytics-table', fileId, table],
    queryFn: () =>
      getJson<AnalyticsTableResponse>(
        `/api/analytics/table?id=${encodeURIComponent(fileId)}&table=${encodeURIComponent(table ?? '')}`,
        'the table',
      ),
    enabled: table !== null,
    retry: false,
    refetchOnWindowFocus: false,
    // A few megabytes per table: keep what was opened, do not refetch it.
    staleTime: 5 * 60 * 1000,
  });
}

/** The aggregates a file's dashboard is drawn from. */
export function useAnalyticsDashboard(fileId: string, enabled: boolean) {
  return useQuery<AnalyticsDashboardResponse>({
    queryKey: ['analytics-dashboard', fileId],
    queryFn: () =>
      getJson<AnalyticsDashboardResponse>(
        `/api/analytics/dashboard?id=${encodeURIComponent(fileId)}`,
        'the dashboard',
      ),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
}

/** The reports under a folder as a series over time. */
export function useAnalyticsTrend(folder: string, enabled: boolean) {
  return useQuery<AnalyticsTrendResponse>({
    queryKey: ['analytics-trend', folder],
    queryFn: () =>
      getJson<AnalyticsTrendResponse>(
        `/api/analytics/trend?folder=${encodeURIComponent(folder)}`,
        'the trend',
      ),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function analyticsExportUrl(
  fileId: string,
  format: 'csv' | 'xlsx',
  table?: string,
): string {
  const query = new URLSearchParams({ id: fileId, format });
  if (table !== undefined) query.set('table', table);
  return `/api/analytics/export?${query.toString()}`;
}

export function analyticsDownloadUrl(fileId: string): string {
  return `/api/analytics/download?id=${encodeURIComponent(fileId)}`;
}
