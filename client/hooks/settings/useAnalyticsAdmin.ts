'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  AnalyticsFieldPolicyAdminResponse,
  AnalyticsFoldersAdminResponse,
  AnalyticsHealthResponse,
} from '@/lib/services/analytics/dto';
import {
  AnalyticsFieldPolicyDocument,
  AnalyticsFoldersDocument,
} from '@/lib/services/analytics/types';
import {
  WriteAnalyticsFieldPolicy,
  WriteAnalyticsFolder,
} from '@/lib/services/analytics/writeSchema';

export class AnalyticsSaveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'AnalyticsSaveError';
  }
}

async function getJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${what}: ${response.status}`);
  }
  return unwrapApiData<T>(await response.json());
}

async function sendJson<T>(
  url: string,
  method: 'PUT' | 'POST',
  payload: unknown,
  etag?: string | null,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      // No header on the first save: the server then creates, and refuses if
      // someone else created meanwhile.
      ...(etag ? { 'if-match': etag } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AnalyticsSaveError(
      response.status,
      body?.code,
      body?.error ?? body?.message ?? 'Save failed',
      typeof body?.details === 'string' ? body.details : undefined,
    );
  }
  return unwrapApiData<T>(await response.json());
}

/** Folder overlay: read + CAS write. */
export function useAnalyticsFoldersAdmin() {
  const queryClient = useQueryClient();
  const query = useQuery<AnalyticsFoldersAdminResponse>({
    queryKey: ['admin-analytics-folders'],
    queryFn: () =>
      getJson<AnalyticsFoldersAdminResponse>(
        '/api/admin/analytics/folders',
        'analytics folders',
      ),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (input: {
      folders: WriteAnalyticsFolder[];
      etag: string | null;
    }) =>
      sendJson<{ document: AnalyticsFoldersDocument; etag: string }>(
        '/api/admin/analytics/folders',
        'PUT',
        { folders: input.folders },
        input.etag,
      ),
    onSettled: () => {
      for (const key of [
        'admin-analytics-folders',
        'admin-analytics-health',
        'analytics-tree',
        'analytics-files',
        'analytics-access',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  return { query, save };
}

/** Field policy: read (any analytics admin) + CAS write (global admins). */
export function useAnalyticsFieldPolicyAdmin() {
  const queryClient = useQueryClient();
  const query = useQuery<AnalyticsFieldPolicyAdminResponse>({
    queryKey: ['admin-analytics-field-policy'],
    queryFn: () =>
      getJson<AnalyticsFieldPolicyAdminResponse>(
        '/api/admin/analytics/field-policy',
        'the field policy',
      ),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (input: {
      policy: WriteAnalyticsFieldPolicy;
      etag: string | null;
    }) =>
      sendJson<{ document: AnalyticsFieldPolicyDocument; etag: string }>(
        '/api/admin/analytics/field-policy',
        'PUT',
        input.policy,
        input.etag,
      ),
    onSettled: () => {
      for (const key of [
        'admin-analytics-field-policy',
        'admin-analytics-health',
        'analytics-files',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  return { query, save };
}

/** Delivery health, plus the "check again" action. */
export function useAnalyticsHealthAdmin() {
  const queryClient = useQueryClient();
  const query = useQuery<AnalyticsHealthResponse>({
    queryKey: ['admin-analytics-health'],
    queryFn: () =>
      getJson<AnalyticsHealthResponse>(
        '/api/admin/analytics/health',
        'analytics health',
      ),
    retry: 1,
    refetchOnWindowFocus: false,
    // Validation runs in the background: keep looking while files are still
    // being checked, then stop.
    refetchInterval: (current) =>
      (current.state.data?.totals.pending ?? 0) > 0 ? 5000 : false,
  });
  const recheck = useMutation({
    mutationFn: (fileId?: string) =>
      sendJson<{ queued: number }>(
        '/api/admin/analytics/recheck',
        'POST',
        fileId ? { id: fileId } : {},
      ),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-analytics-health'] });
      queryClient.invalidateQueries({ queryKey: ['analytics-files'] });
    },
  });
  return { query, recheck };
}
