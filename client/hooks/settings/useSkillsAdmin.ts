/**
 * Admin skills data layer (docs/SKILLS_DESIGN.md §4): list via react-query,
 * save/delete mutations with If-Match CAS against
 * /api/agent-access/skills. Conflict (409 AGENT_ACCESS_CONFLICT) surfaces as
 * SkillSaveConflict so the panel can show the reload-and-retry banner, the
 * web-search admin pattern.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Skill, SkillWriteFields } from '@/lib/services/skills/types';

import { unwrapApiData } from './useAgentAccessAdmin';

export interface AdminSkillEntry {
  canonicalKey: string;
  skill: Skill;
  /** null = compiled built-in default with no stored override to CAS on. */
  etag: string | null;
  builtin: boolean;
  overridden: boolean;
  /** False for informational built-in rows shown to local admins. */
  editable?: boolean;
  requiresReindex?: boolean;
}

export interface AdminSkillsResponse {
  skills: AdminSkillEntry[];
  skillsUnavailable: boolean;
  fetchedAt: number | null;
}

export class SkillSaveConflict extends Error {
  constructor() {
    super('Skill was modified by another admin');
    this.name = 'SkillSaveConflict';
  }
}

const QUERY_KEY = ['admin-skills'];

async function throwForStatus(response: Response): Promise<never> {
  if (response.status === 409) throw new SkillSaveConflict();
  throw new Error(`Skill request failed: ${response.status}`);
}

export function useSkillsAdmin() {
  const queryClient = useQueryClient();

  const query = useQuery<AdminSkillsResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await fetch('/api/agent-access/skills');
      if (!response.ok) {
        throw new Error(`Failed to fetch skills: ${response.status}`);
      }
      return unwrapApiData<AdminSkillsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    mutationFn: async (input: {
      fields: SkillWriteFields;
      /** null → create (new skill or first built-in override) via POST. */
      etag: string | null;
      files?: File[];
    }) => {
      const form = input.files?.length ? new FormData() : undefined;
      if (form) {
        form.append('fields', JSON.stringify(input.fields));
        for (const file of input.files!) form.append('files', file);
      }
      const response = await fetch('/api/agent-access/skills', {
        method: input.etag ? 'PUT' : 'POST',
        headers: {
          ...(form ? {} : { 'content-type': 'application/json' }),
          ...(input.etag ? { 'if-match': input.etag } : {}),
        },
        body: form ?? JSON.stringify(input.fields),
      });
      if (!response.ok) await throwForStatus(response);
      return unwrapApiData<{ skill: Skill; etag: string }>(
        await response.json(),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const remove = useMutation({
    mutationFn: async (input: { id: string; etag: string }) => {
      const response = await fetch(
        `/api/agent-access/skills?id=${encodeURIComponent(input.id)}`,
        { method: 'DELETE', headers: { 'if-match': input.etag } },
      );
      // 404 = already gone — the desired end state holds (guides contract).
      if (!response.ok && response.status !== 404) {
        await throwForStatus(response);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return { query, save, remove };
}
