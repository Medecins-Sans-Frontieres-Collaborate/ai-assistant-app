import type { M365AgentSource } from '@/lib/services/agentAccess/types';

import type { AdminStoredRule } from './types';

/** Public, already-authorized metadata to search, with no additional requests. */
export type AgentSearchMetadata = unknown;

/**
 * Counts content-bearing sources for both display and search. Failed/missing
 * sources are excluded; legacy indexed records without chunk counts are trusted.
 * This measures indexed content only, never a user's underlying file permission.
 */
export function countM365ContentSources(
  sources: readonly M365AgentSource[],
): number {
  return sources.filter(
    (source) =>
      source.status !== 'error' &&
      source.status !== 'missing' &&
      (source.indexedChunks ?? (source.status === 'indexed' ? 1 : 0)) > 0,
  ).length;
}

/** Uses the same audience distinctions as the row, including empty restrictions. */
export function agentAudienceSearchLabel(
  access: AdminStoredRule['rule']['access'] | undefined,
  labels: { everyone: string; restricted: string; none: string },
): string {
  if (access?.type !== 'restricted') return labels.everyone;
  return [access.allowDomains, access.allowUsers, access.allowGroups].some(
    (values) => values?.length,
  )
    ? labels.restricted
    : labels.none;
}

/**
 * Builds a normalized search document from JSON-shaped admin metadata values.
 * Field names are excluded so a "failed: 0" count does not match "failed".
 * Cycles are ignored; null/undefined are
 * omitted. Never fetches prompts, file content or directory memberships.
 */
export function agentSearchDocument(metadata: AgentSearchMetadata): string {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): string[] => {
    if (value === null || value === undefined) return [];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      return [String(value)];
    if (typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    if (Array.isArray(value)) return value.flatMap(visit);
    return Object.values(value).flatMap(visit);
  };
  return visit(metadata)
    .join(' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Case/accent-insensitive AND search; each whitespace-delimited term must match. */
export function matchesAgentSearch(document: string, query: string): boolean {
  return query
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .every((term) => document.includes(term));
}
