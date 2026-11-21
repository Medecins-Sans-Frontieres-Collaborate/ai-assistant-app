/**
 * The global admin's unsaved policy and the pure edits the limits screens
 * make to it. No React here: every screen edits through these functions so
 * an edit means the same thing wherever it is made, and they are testable
 * on their own.
 *
 * Value convention (types.ts): a value of `undefined` means "not set here,
 * inherit"; `null` means unlimited; a number is a cap; `false` or `0` is off.
 */
import {
  LimitCell,
  PolicyChange,
  cellId,
} from '@/lib/services/limits/policyChanges';
import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitValue,
  LimitsFailMode,
  LimitsMode,
  LimitsPolicy,
  ModelAccessRule,
  OverrideScope,
} from '@/lib/services/limits/types';

import { PolicyResponse } from '@/components/Limits/types';

/** Everything the PUT sends. */
export interface LimitsDraft {
  defaults: LimitEntry[];
  /** Model approval rules (docs/LIMITS.md "Model approval"); always sent. */
  modelAccess: ModelAccessRule[];
  overrides: LimitOverride[];
  /**
   * ⚠ Must be present on every PUT. The server refuses a body lacking the
   * key once any delegation is stored (design §9 stale-client guard).
   */
  delegations: LimitDelegation[];
  mode: LimitsMode;
  failMode: LimitsFailMode;
  timezone: string;
  countByomUsage: boolean;
  countAuxiliaryUsage: boolean;
}

export const EMPTY_DRAFT: LimitsDraft = {
  defaults: [],
  modelAccess: [],
  overrides: [],
  delegations: [],
  mode: 'observe',
  failMode: 'open',
  timezone: 'UTC',
  countByomUsage: false,
  countAuxiliaryUsage: false,
};

/** The editable part of a stored policy. */
export function draftFrom(data: PolicyResponse): LimitsDraft {
  return data.policy
    ? {
        defaults: data.policy.defaults,
        modelAccess: data.policy.modelAccess ?? [],
        overrides: data.policy.overrides,
        delegations: data.policy.delegations ?? [],
        mode: data.policy.mode,
        failMode: data.policy.failMode,
        timezone: data.policy.timezone,
        countByomUsage: data.policy.countByomUsage,
        countAuxiliaryUsage: data.policy.countAuxiliaryUsage,
      }
    : EMPTY_DRAFT;
}

/**
 * The draft as a whole policy, so the resolver, the explanations and the
 * diff can run on it exactly as enforcement runs on the saved one.
 *
 * @param draft - The edited fields.
 * @param saved - The stored policy (for the fields a draft does not edit).
 */
export function draftPolicy(
  draft: LimitsDraft,
  saved: LimitsPolicy | null,
): LimitsPolicy {
  return {
    ...(saved ?? {}),
    version: 1,
    ...draft,
    ...(saved?.groupLabels ? { groupLabels: saved.groupLabels } : {}),
    updatedBy: saved?.updatedBy ?? '',
    updatedAt: saved?.updatedAt ?? '',
  };
}

function sameCell(entry: LimitEntry, cell: LimitCell): boolean {
  return cellId(entry) === cellId(cell);
}

/** The entry for a cell in a list, if set. */
export function entryFor(
  entries: readonly LimitEntry[],
  cell: LimitCell,
): LimitEntry | undefined {
  return entries.find((entry) => sameCell(entry, cell));
}

/**
 * Sets, changes or removes one cell in an entry list.
 *
 * @param value - `undefined` removes the entry (inherit).
 * @param ceiling - Kept from the existing entry when omitted.
 */
export function withEntry(
  entries: readonly LimitEntry[],
  cell: LimitCell,
  value: LimitValue | undefined,
  ceiling?: boolean,
): LimitEntry[] {
  const existing = entryFor(entries, cell);
  const rest = entries.filter((entry) => !sameCell(entry, cell));
  if (value === undefined) return rest;
  const next: LimitEntry = {
    limitKey: cell.limitKey,
    ...(cell.modelId ? { modelId: cell.modelId } : {}),
    ...(cell.series ? { series: cell.series } : {}),
    value,
    ceiling: ceiling ?? existing?.ceiling ?? false,
  };
  if (!existing) return [...entries, next];
  return entries.map((entry) => (sameCell(entry, cell) ? next : entry));
}

/** Replaces one override by id. */
export function withOverride(
  overrides: readonly LimitOverride[],
  next: LimitOverride,
): LimitOverride[] {
  return overrides.map((override) =>
    override.id === next.id ? next : override,
  );
}

/** One rule that sets a cell, for the Overview's exceptions and rule list. */
export interface CellRule {
  override: LimitOverride;
  entry: LimitEntry;
}

/**
 * Every override that sets `limitKey` (any qualifier when `anyQualifier`,
 * else only the unqualified cell), most specific audience first.
 */
export function rulesForKey(
  overrides: readonly LimitOverride[],
  limitKey: string,
  anyQualifier = false,
): CellRule[] {
  const rank: Record<OverrideScope, number> = {
    user: 0,
    group: 1,
    attribute: 2,
    domain: 3,
  };
  const out: CellRule[] = [];
  for (const override of overrides) {
    for (const entry of override.entries) {
      if (entry.limitKey !== limitKey) continue;
      if (!anyQualifier && (entry.modelId || entry.series)) continue;
      out.push({ override, entry });
    }
  }
  return out.sort(
    (a, b) =>
      rank[a.override.scope] - rank[b.override.scope] ||
      a.override.id.localeCompare(b.override.id),
  );
}

/** Exception counts by audience kind, split by who set them. */
export type ExceptionCounts = Record<
  OverrideScope,
  { global: number; delegated: number }
>;

/** How many rules of each audience kind set `limitKey` (enabled ones only). */
export function exceptionCounts(
  overrides: readonly LimitOverride[],
  limitKey: string,
): ExceptionCounts {
  const counts: ExceptionCounts = {
    domain: { global: 0, delegated: 0 },
    attribute: { global: 0, delegated: 0 },
    group: { global: 0, delegated: 0 },
    user: { global: 0, delegated: 0 },
  };
  const seen = new Set<string>();
  for (const { override } of rulesForKey(overrides, limitKey, true)) {
    if (!override.enabled || seen.has(override.id)) continue;
    seen.add(override.id);
    counts[override.scope][override.delegationId ? 'delegated' : 'global'] += 1;
  }
  return counts;
}

const SETTING_NAMES = [
  'mode',
  'failMode',
  'timezone',
  'countByomUsage',
  'countAuxiliaryUsage',
] as const;

/**
 * Undoes ONE change from `diffPolicies(saved, draft)`, leaving every other
 * edit in the draft alone.
 *
 * @param draft - The current draft.
 * @param saved - The stored policy the diff was taken against.
 * @param change - One entry of that diff.
 * @returns The draft with that change reverted.
 */
export function revertChange(
  draft: LimitsDraft,
  saved: LimitsPolicy | null,
  change: PolicyChange,
): LimitsDraft {
  const savedOverride = (id: string) =>
    saved?.overrides.find((override) => override.id === id);

  if (change.type === 'value') {
    const { cell, before } = change;
    if (change.audience.kind === 'everyone') {
      return {
        ...draft,
        defaults: withEntry(draft.defaults, cell, before.value, before.ceiling),
      };
    }
    const id = change.audience.overrideId;
    const current = draft.overrides.find((override) => override.id === id);
    const was = savedOverride(id);
    // The rule was removed: its values come back only with the rule itself.
    if (!current) {
      return was ? { ...draft, overrides: [...draft.overrides, was] } : draft;
    }
    // A value change on a rule switched off or on is the switch's to undo.
    if (was && was.enabled !== current.enabled) {
      return {
        ...draft,
        overrides: withOverride(draft.overrides, {
          ...current,
          enabled: was.enabled,
          entries: withEntry(
            current.entries,
            cell,
            before.value,
            before.ceiling,
          ),
        }),
      };
    }
    return {
      ...draft,
      overrides: withOverride(draft.overrides, {
        ...current,
        entries: withEntry(current.entries, cell, before.value, before.ceiling),
      }),
    };
  }

  if (change.type === 'rule') {
    const id = change.audience.overrideId;
    const was = savedOverride(id);
    const current = draft.overrides.find((override) => override.id === id);
    switch (change.change) {
      case 'added':
        return {
          ...draft,
          overrides: draft.overrides.filter((override) => override.id !== id),
        };
      case 'removed':
        return was ? { ...draft, overrides: [...draft.overrides, was] } : draft;
      default:
        if (!was || !current) return draft;
        return {
          ...draft,
          overrides: withOverride(draft.overrides, {
            ...current,
            ...(change.change === 'enabled' || change.change === 'disabled'
              ? { enabled: was.enabled }
              : change.change === 'priority'
                ? { priority: was.priority }
                : {
                    scope: was.scope,
                    targets: was.targets,
                    ...(was.delegationId
                      ? { delegationId: was.delegationId }
                      : { delegationId: undefined }),
                  }),
          }),
        };
    }
  }

  if (change.type === 'setting') {
    const name = SETTING_NAMES.find((setting) => setting === change.subject);
    if (!name || !saved) return draft;
    return { ...draft, [name]: saved[name] };
  }

  if (change.type === 'delegation') {
    const byLabel = (list: readonly LimitDelegation[]) =>
      list.find((d) => (d.label || d.id) === change.subject);
    const was = saved ? byLabel(saved.delegations) : undefined;
    const now = byLabel(draft.delegations);
    if (was && now) {
      return {
        ...draft,
        delegations: draft.delegations.map((d) => (d.id === now.id ? was : d)),
      };
    }
    if (was) return { ...draft, delegations: [...draft.delegations, was] };
    if (now) {
      return {
        ...draft,
        delegations: draft.delegations.filter((d) => d.id !== now.id),
      };
    }
    return draft;
  }

  // Model access: restore the saved rule for this model or family.
  const key = (rule: ModelAccessRule) =>
    rule.modelId ? `model:${rule.modelId}` : `family:${rule.series ?? ''}`;
  const was = saved?.modelAccess.find((rule) => key(rule) === change.subject);
  const rest = draft.modelAccess.filter((rule) => key(rule) !== change.subject);
  return { ...draft, modelAccess: was ? [...rest, was] : rest };
}
