/**
 * Client-side types and helpers for the limits admin panel.
 *
 * The panel edits the policy as a nested draft and flattens it on save; these
 * helpers own that translation so the sparse-entry contract (an ABSENT key
 * means inherit, a `null` value means explicitly unlimited) survives a round
 * trip through the form.
 */
import {
  LimitEntry,
  LimitOverride,
  LimitsPolicy,
} from '@/lib/services/limits/types';

import { LimitValueState } from '@/components/Limits/LimitValueInput';

export interface PolicyResponse {
  policy: LimitsPolicy | null;
  etag: string | null;
  /** Storage read failed — render an error + Retry, NEVER an empty form. */
  policyUnavailable: boolean;
}

/** A draft entry keyed for the form: `<limitKey>` or `<limitKey>@model:<id>`. */
export type EntryDraft = Record<string, LimitValueState | undefined>;

export function draftKey(
  limitKey: string,
  modelId?: string,
  series?: string,
): string {
  if (modelId) return `${limitKey}@model:${modelId}`;
  if (series) return `${limitKey}@family:${series}`;
  return limitKey;
}

export function parseDraftKey(key: string): {
  limitKey: string;
  modelId?: string;
  series?: string;
} {
  const [limitKey, qualifier] = key.split('@');
  if (!qualifier) return { limitKey };
  if (qualifier.startsWith('model:')) {
    return { limitKey, modelId: qualifier.slice('model:'.length) };
  }
  return { limitKey, series: qualifier.slice('family:'.length) };
}

export function entriesToDraft(entries: LimitEntry[]): EntryDraft {
  const draft: EntryDraft = {};
  for (const entry of entries) {
    draft[draftKey(entry.limitKey, entry.modelId, entry.series)] = entry.value;
  }
  return draft;
}

/**
 * Flattens a draft back to stored entries. Keys whose value is `undefined`
 * are OMITTED — that is what "inherit" means on the wire, and writing them as
 * null would silently grant unlimited.
 */
export function draftToEntries(
  draft: EntryDraft,
  ceilings: Record<string, boolean> = {},
): LimitEntry[] {
  const entries: LimitEntry[] = [];
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) continue;
    const { limitKey, modelId, series } = parseDraftKey(key);
    entries.push({
      limitKey,
      ...(modelId ? { modelId } : {}),
      ...(series ? { series } : {}),
      value,
      ceiling: ceilings[key] ?? false,
    });
  }
  return entries;
}

export function ceilingsFromEntries(
  entries: LimitEntry[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const entry of entries) {
    out[draftKey(entry.limitKey, entry.modelId, entry.series)] = entry.ceiling;
  }
  return out;
}

/** Client-side id generator matching the server's `lim-<12 hex>` shape. */
export function newOverrideId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `lim-${hex}`;
}

export function emptyOverride(scope: LimitOverride['scope']): LimitOverride {
  const now = new Date().toISOString();
  return {
    id: newOverrideId(),
    label: '',
    enabled: true,
    scope,
    targets: [],
    priority: 0,
    entries: [],
    createdBy: '',
    createdAt: now,
    updatedBy: '',
    updatedAt: now,
  };
}
