'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import { TranslationOutcome } from '@/lib/services/announcements/translate';
import { Announcement } from '@/lib/services/announcements/types';
import { AnnouncementWrite } from '@/lib/services/announcements/writePath';
import { JurisdictionPredicate } from '@/lib/services/limits/types';

export interface AnnouncementsAdminDelegation {
  id: string;
  label: string;
  enabled: boolean;
  jurisdiction: JurisdictionPredicate[];
}

export interface AnnouncementsAdminResponse {
  announcements: Announcement[];
  allowedLinkHosts: string[];
  delegations: AnnouncementsAdminDelegation[];
  isGlobalAdmin: boolean;
  unavailable: boolean;
}

export class AnnouncementsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'AnnouncementsRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AnnouncementsRequestError(
      response.status,
      body?.code,
      body?.error ?? body?.message ?? 'Request failed',
      typeof body?.details === 'string' ? body.details : undefined,
    );
  }
  return unwrapApiData<T>(await response.json());
}

const QUERY_KEY = ['admin-announcements'];

/** Admin reads and single-record writes for announcements. */
export function useAnnouncementsAdmin() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const query = useQuery<AnnouncementsAdminResponse>({
    queryKey: QUERY_KEY,
    queryFn: () =>
      request<AnnouncementsAdminResponse>('/api/admin/announcements'),
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: (input: { id?: string; body: AnnouncementWrite }) =>
      request<{ announcement: Announcement }>(
        input.id
          ? `/api/admin/announcements/${input.id}`
          : '/api/admin/announcements',
        { method: input.id ? 'PUT' : 'POST', body: JSON.stringify(input.body) },
      ),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      request<{ deleted: string }>(`/api/admin/announcements/${id}`, {
        method: 'DELETE',
      }),
    onSettled: invalidate,
  });

  const translate = useMutation({
    mutationFn: (input: {
      sourceLocale: string;
      title: string;
      body: string;
      actionLabel?: string;
      variableNames: string[];
      targetLocales?: string[];
    }) =>
      request<TranslationOutcome>('/api/admin/announcements/translate', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });

  const allowHost = useMutation({
    mutationFn: (input: { host?: string; announcementId?: string }) =>
      request<{ host: string; allowedLinkHosts: string[] }>(
        '/api/admin/announcements/allowed-hosts',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSettled: invalidate,
  });

  const removeHost = useMutation({
    mutationFn: (host: string) =>
      request<{ allowedLinkHosts: string[] }>(
        `/api/admin/announcements/allowed-hosts?host=${encodeURIComponent(host)}`,
        { method: 'DELETE' },
      ),
    onSettled: invalidate,
  });

  return { query, save, remove, translate, allowHost, removeHost };
}
