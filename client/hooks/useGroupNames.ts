'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { lookupEntraGroups } from '@/client/services/m365/m365Client';
import type {
  JurisdictionPredicate,
  OverrideScope,
} from '@/lib/services/limits/types';

/**
 * One client-side name cache for Entra group ids, shared by every admin
 * surface that shows one (override cards, scope summaries, model-approval
 * grant lists, the group picker's chips).
 *
 * Seeded from the policy's stored `groupLabels` the moment a panel loads,
 * so lists render names with no request at all; ids the policy has no
 * label for are resolved through ONE batched lookup per distinct set
 * (`lookupEntraGroups`, POST /api/m365/groups) and remembered for the
 * session. Before this each component asked the server per node, per
 * mount, one GET per id on the server side.
 *
 * Names are display only. A missing name falls back to the id; nothing here
 * affects what a rule matches.
 */
const names = new Map<string, string>();
/** Bumped on every write so subscribers' memos recompute. */
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Puts stored labels into the cache (policy `groupLabels`, scoped view). */
export function seedGroupNames(
  labels: Record<string, string> | undefined | null,
): void {
  if (!labels) return;
  let changed = false;
  for (const [id, name] of Object.entries(labels)) {
    const key = id.trim().toLowerCase();
    if (!key || !name || names.get(key) === name) continue;
    names.set(key, name);
    changed = true;
  }
  if (changed) notify();
}

/** Remembers a name learned from a search result or lookup. */
export function rememberGroupName(id: string, name: string): void {
  const key = id.trim().toLowerCase();
  if (!key || !name || names.get(key) === name) return;
  names.set(key, name);
  notify();
}

/** Test hook. */
export function clearGroupNamesForTests(): void {
  names.clear();
  notify();
}

/** `Health team (0f3a9c2b…)` — the name first, enough id to disambiguate. */
export function formatGroupLabel(id: string, name: string | undefined): string {
  return name ? `${name} (${id.slice(0, 8)}…)` : id;
}

/** Distinct, lowercased group ids referenced by overrides and jurisdictions. */
export function collectClientGroupIds(input: {
  overrides?: readonly { scope: OverrideScope; targets: readonly string[] }[];
  jurisdictions?: readonly (readonly JurisdictionPredicate[])[];
  grants?: readonly string[];
}): string[] {
  const ids = new Set<string>();
  const add = (value: string) => {
    const id = value.trim().toLowerCase();
    if (id) ids.add(id);
  };
  for (const override of input.overrides ?? []) {
    if (override.scope === 'group') override.targets.forEach(add);
  }
  for (const jurisdiction of input.jurisdictions ?? []) {
    for (const predicate of jurisdiction) {
      if (predicate.scope === 'group') predicate.targets.forEach(add);
    }
  }
  (input.grants ?? []).forEach(add);
  return [...ids].sort();
}

/**
 * Names for `ids`: cache hits immediately, the rest after one batched
 * lookup. Returns a plain record keyed by the ids as passed (original
 * casing), so `labels[target]` works for the caller's own strings.
 */
export function useGroupNames(ids: readonly string[]): Record<string, string> {
  const normalized = useMemo(
    () => [...new Set(ids.map((id) => id.trim().toLowerCase()))].sort(),
    // A new array with the same ids must not refetch: key on content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids.join('\u0000')],
  );
  const missing = normalized.filter((id) => !names.has(id));
  const query = useQuery({
    queryKey: ['group-names', ...missing],
    queryFn: () => lookupEntraGroups(missing),
    enabled: missing.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  useEffect(() => {
    if (!query.data) return;
    for (const group of query.data) rememberGroupName(group.id, group.name);
  }, [query.data]);

  // Subscribe to cache writes so a name learned by a sibling renders here too.
  const [, rerender] = useSubscribeToNames();
  void rerender;

  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const name = names.get(id.trim().toLowerCase());
      if (name) out[id] = name;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('\u0000'), version, query.data]);
}

function useSubscribeToNames(): [number, () => void] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [tick, () => setTick((t) => t + 1)];
}
