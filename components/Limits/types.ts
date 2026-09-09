/**
 * Client-side types and helpers for the limits admin panel.
 *
 * The panel edits the policy as a nested draft and flattens it on save; these
 * helpers own that translation so the sparse-entry contract (an ABSENT key
 * means inherit, a `null` value means explicitly unlimited) survives a round
 * trip through the form.
 */
import type {
  ScopedEntryBody,
  ScopedOverrideBody,
} from '@/client/hooks/settings/useLimitsAdmin';

import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitsPolicy,
} from '@/lib/services/limits/types';

import type { LimitValueState } from '@/components/Limits/LimitValueInput';

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

function randomHex12(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Client-side id generator matching the server's `lim-<12 hex>` shape. */
export function newOverrideId(): string {
  return `lim-${randomHex12()}`;
}

/**
 * Client-side delegation id in the server's `del-<12 hex>` shape. Used ONLY
 * as a stable React key / draft handle: the full PUT omits the id for a
 * delegation created this session and the server generates the stored one
 * (design §2), so nothing may reference this value across a save.
 */
export function newDelegationId(): string {
  return `del-${randomHex12()}`;
}

/**
 * A fresh override. `delegationId` stamps a SCOPED record (created under a
 * delegation in scoped mode, or assigned by a global admin); priority stays
 * 0 and no entry carries a ceiling, matching what the scoped write path
 * forces (design §4).
 */
export function emptyOverride(
  scope: LimitOverride['scope'],
  delegationId?: string,
): LimitOverride {
  const now = new Date().toISOString();
  return {
    id: newOverrideId(),
    label: '',
    enabled: true,
    scope,
    targets: [],
    priority: 0,
    ...(delegationId ? { delegationId } : {}),
    entries: [],
    createdBy: '',
    createdAt: now,
    updatedBy: '',
    updatedAt: now,
  };
}

/**
 * A fresh delegation draft: one empty domain predicate so the editor opens
 * on the anchored shape (design §8), default budget 25. Timestamps and
 * authors are placeholders the server overwrites.
 */
export function emptyDelegation(): LimitDelegation {
  const now = new Date().toISOString();
  return {
    id: newDelegationId(),
    label: '',
    enabled: true,
    admins: [],
    jurisdiction: [{ scope: 'domain', targets: [] }],
    maxOverrides: 25,
    createdBy: '',
    createdAt: now,
    updatedBy: '',
    updatedAt: now,
  };
}

/**
 * Override draft → strict scoped PUT body (design §5): drops `delegationId`
 * (it travels in the query string), `priority` (forced to 0 server-side),
 * every `ceiling` flag (a scoped record never pins a cell — the server
 * would refuse a `true`), and the audit fields. Blank targets are dropped.
 */
export function scopedOverrideBody(
  override: LimitOverride,
): ScopedOverrideBody {
  const entries: ScopedEntryBody[] = override.entries.map((entry) => ({
    limitKey: entry.limitKey,
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    ...(entry.series ? { series: entry.series } : {}),
    value: entry.value,
  }));
  return {
    id: override.id,
    label: override.label,
    enabled: override.enabled,
    scope: override.scope,
    targets: override.targets
      .map((target) => target.trim())
      .filter((target) => target.length > 0),
    entries,
  };
}
