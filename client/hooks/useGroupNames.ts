'use client';

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
 * label for are resolved through ONE batched lookup per render tick
 * (`lookupEntraGroups`, POST /api/m365/groups) and remembered for the
 * session. Before this each component asked the server per node, per
 * mount, and the server issued one Graph GET per id.
 *
 * Deliberately not built on react-query: these components render inside
 * admin pages AND in isolation (tests, storybook-style previews), and a
 * display-name cache must never be the reason a card needs a provider.
 *
 * Names are display only. A missing name falls back to the id; nothing here
 * affects what a rule matches.
 */
const names = new Map<string, string>();
/** Ids asked for and not answered (deleted group, lookup failure), with when. */
const unknownUntil = new Map<string, number>();
const UNKNOWN_RETRY_MS = 60 * 1000;
/** Ids currently in flight, so concurrent mounts share one request. */
let inFlight: Set<string> = new Set();
let scheduled = false;
let queued: Set<string> = new Set();

let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function key(id: string): string {
  return id.trim().toLowerCase();
}

/** Puts stored labels into the cache (policy `groupLabels`, scoped view). */
export function seedGroupNames(
  labels: Record<string, string> | undefined | null,
): void {
  if (!labels) return;
  let changed = false;
  for (const [id, name] of Object.entries(labels)) {
    const k = key(id);
    if (!k || !name || names.get(k) === name) continue;
    names.set(k, name);
    changed = true;
  }
  if (changed) notify();
}

/** Remembers a name learned from a search result or lookup. */
export function rememberGroupName(id: string, name: string): void {
  const k = key(id);
  if (!k || !name || names.get(k) === name) return;
  names.set(k, name);
  unknownUntil.delete(k);
  notify();
}

/** Test hook. */
export function clearGroupNamesForTests(): void {
  names.clear();
  unknownUntil.clear();
  inFlight = new Set();
  queued = new Set();
  scheduled = false;
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
    const k = key(value);
    if (k) ids.add(k);
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
 * Queues ids for one batched lookup on the next microtask, so every
 * component mounting in the same render contributes to a single request.
 */
function requestNames(ids: readonly string[]): void {
  const now = Date.now();
  for (const id of ids) {
    if (names.has(id) || inFlight.has(id) || queued.has(id)) continue;
    const retryAt = unknownUntil.get(id);
    if (retryAt !== undefined && retryAt > now) continue;
    queued.add(id);
  }
  if (queued.size === 0 || scheduled) return;
  scheduled = true;
  void Promise.resolve().then(flush);
}

async function flush(): Promise<void> {
  scheduled = false;
  const batch = [...queued];
  queued = new Set();
  if (batch.length === 0) return;
  for (const id of batch) inFlight.add(id);
  try {
    const found = await lookupEntraGroups(batch);
    const answered = new Set<string>();
    for (const group of found) {
      const k = key(group.id);
      answered.add(k);
      if (group.name) names.set(k, group.name);
      unknownUntil.delete(k);
    }
    const until = Date.now() + UNKNOWN_RETRY_MS;
    for (const id of batch) if (!answered.has(id)) unknownUntil.set(id, until);
  } catch {
    const until = Date.now() + UNKNOWN_RETRY_MS;
    for (const id of batch) unknownUntil.set(id, until);
  } finally {
    for (const id of batch) inFlight.delete(id);
    notify();
  }
}

/**
 * Names for `ids`: cache hits immediately, the rest after one batched
 * lookup. Returns a plain record keyed by the ids as passed (original
 * casing), so `labels[target]` works for the caller's own strings.
 */
export function useGroupNames(ids: readonly string[]): Record<string, string> {
  const joined = ids.join('\u0000');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    requestNames([...new Set(ids.map(key))]);
    // Content, not identity: a new array with the same ids is the same ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const name = names.get(key(id));
      if (name) out[id] = name;
    }
    return out;
    // `tick`/`version` make the memo recompute after a cache write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, tick, version]);
}
