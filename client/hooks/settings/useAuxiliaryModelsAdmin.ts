'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AuxiliaryAdminReport,
  AuxiliaryAssignments,
  AuxiliaryPurpose,
  AuxiliaryReference,
  AuxiliaryRegion,
} from '@/lib/services/auxiliary/types';

import { unwrapApiData } from './useAgentAccessAdmin';

/** Admin transport errors carry safe HTTP classification and optional validation detail. */
export class AuxiliaryAdminError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = 'AuxiliaryAdminError';
  }
}

async function requestReport(
  init?: RequestInit,
  refresh = false,
): Promise<AuxiliaryAdminReport> {
  const response = await fetch(
    `/api/admin/auxiliary-models${refresh ? '?refresh=1' : ''}`,
    init,
  );
  const body = await response.json();
  if (!response.ok)
    throw new AuxiliaryAdminError(
      response.status,
      typeof body.error === 'string' ? body.error : 'Request failed',
    );
  return unwrapApiData<AuxiliaryAdminReport>(body);
}

/** Global-admin policy read, CAS save, and fixed probes; mutations update only this query's report. */
export function useAuxiliaryModelsAdmin() {
  const client = useQueryClient();
  const key = ['auxiliary-models-admin'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => requestReport(),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const update = (report: AuxiliaryAdminReport) =>
    client.setQueryData(key, report);
  const refresh = useMutation({
    mutationFn: () => requestReport(undefined, true),
    onSuccess: update,
  });
  const save = useMutation({
    mutationFn: ({
      assignments,
      etag,
    }: {
      assignments: AuxiliaryAssignments;
      etag: string | null;
    }) =>
      requestReport({
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(etag ? { 'if-match': etag } : {}),
        },
        body: JSON.stringify({ assignments }),
      }),
    onSuccess: update,
  });
  const probe = useMutation({
    mutationFn: (input: {
      reference: AuxiliaryReference;
      purpose: AuxiliaryPurpose;
      region: AuxiliaryRegion;
    }) =>
      requestReport({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: update,
  });
  return { query, refresh, save, probe };
}
