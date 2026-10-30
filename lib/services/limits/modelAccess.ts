/**
 * Model approval rules → resolver candidates (docs/LIMITS.md "Model
 * approval").
 *
 * The admin edits a tree (family → models) with, per node, a default for
 * everyone and four lists: groups, domains, an allow list and a block list.
 * Rather than teaching the resolver a second vocabulary, each rule is
 * EXPANDED here into the entries and overrides it is equivalent to, and the
 * resolver reads `effectiveDefaults` / `effectiveOverrides` (resolver.ts)
 * instead of the stored arrays. One comparator, one precedence model:
 *
 *  - a node's default becomes GLOBAL-layer defaults qualified by its model
 *    id or series — `model.allowed` plus, when available, `model.requests`;
 *  - each list becomes global-tier overrides at the list's layer (group,
 *    domain, user), one per distinct `requests` value so targets with the
 *    same terms share a record; grants set `model.allowed = true` and
 *    `model.requests`, the block list sets `model.allowed = false`.
 *
 * Precedence then follows from the layers: a person on a list beats every
 * default; a model rule beats its family's at the same layer (qualifier
 * specificity); block beats allow for one person at equal rank (more
 * restrictive wins) — and the write schema refuses that overlap anyway.
 *
 * Pure and client-importable: the admin preview runs the same expansion
 * over its draft.
 */
import type {
  LimitEntry,
  LimitOverride,
  ModelAccessGrant,
  ModelAccessRule,
  OverrideScope,
} from '@/lib/services/limits/types';

/** Synthetic override ids — never stored, recognisable in provenance. */
export const MODEL_ACCESS_OVERRIDE_PREFIX = 'model-access:';

export type ModelAccessList = 'groups' | 'domains' | 'allow' | 'deny';

const LIST_SCOPE: Record<ModelAccessList, OverrideScope> = {
  groups: 'group',
  domains: 'domain',
  allow: 'user',
  deny: 'user',
};

/** `model:<id>` | `family:<series>` — the node's identity across the UI and provenance. */
export function modelAccessDimension(
  rule: Pick<ModelAccessRule, 'modelId' | 'series'>,
): string {
  if (rule.modelId) return `model:${rule.modelId.toLowerCase()}`;
  return `family:${(rule.series ?? '').toLowerCase()}`;
}

export function isModelAccessOverrideId(id: string | undefined): boolean {
  return !!id && id.startsWith(MODEL_ACCESS_OVERRIDE_PREFIX);
}

/** The dimension and list behind a synthetic id, for admin-facing provenance. */
export function describeModelAccessOverrideId(
  id: string,
): { dimension: string; list: ModelAccessList } | null {
  if (!isModelAccessOverrideId(id)) return null;
  const parts = id.slice(MODEL_ACCESS_OVERRIDE_PREFIX.length).split('|');
  const list = parts[1] as ModelAccessList | undefined;
  if (!list || !(list in LIST_SCOPE)) return null;
  return { dimension: parts[0], list };
}

function qualifier(
  rule: ModelAccessRule,
): Pick<LimitEntry, 'modelId' | 'series'> {
  return rule.modelId ? { modelId: rule.modelId } : { series: rule.series };
}

function entry(
  rule: ModelAccessRule,
  limitKey: string,
  value: LimitEntry['value'],
): LimitEntry {
  return { limitKey, ...qualifier(rule), value, ceiling: false };
}

/** The entries a GRANT with these terms contributes: available, then its cap. */
function grantEntries(
  rule: ModelAccessRule,
  requests: number | null,
): LimitEntry[] {
  return [
    entry(rule, 'model.allowed', true),
    entry(rule, 'model.requests', requests),
  ];
}

function defaultEntries(rule: ModelAccessRule): LimitEntry[] {
  if (rule.defaultAccess === undefined) return [];
  if (rule.defaultAccess === false)
    return [entry(rule, 'model.allowed', false)];
  return grantEntries(rule, rule.defaultAccess);
}

const SYNTHETIC_STAMP = '1970-01-01T00:00:00.000Z';
const SYNTHETIC_AUTHOR = 'model-access';

function syntheticOverride(
  id: string,
  scope: OverrideScope,
  targets: string[],
  entries: LimitEntry[],
): LimitOverride {
  return {
    id,
    label: '',
    enabled: true,
    scope,
    targets,
    priority: 0,
    entries,
    createdBy: SYNTHETIC_AUTHOR,
    createdAt: SYNTHETIC_STAMP,
    updatedBy: SYNTHETIC_AUTHOR,
    updatedAt: SYNTHETIC_STAMP,
  };
}

/** Grants grouped by their terms: one override per distinct `requests`. */
function grantOverrides(
  rule: ModelAccessRule,
  list: Exclude<ModelAccessList, 'deny'>,
): LimitOverride[] {
  const dimension = modelAccessDimension(rule);
  const byTerms = new Map<
    string,
    { requests: number | null; targets: string[] }
  >();
  for (const grant of rule[list] as ModelAccessGrant[]) {
    const target = grant.target.trim().toLowerCase();
    if (!target) continue;
    const key = grant.requests === null ? 'unlimited' : String(grant.requests);
    const bucket = byTerms.get(key) ?? {
      requests: grant.requests,
      targets: [],
    };
    if (!bucket.targets.includes(target)) bucket.targets.push(target);
    byTerms.set(key, bucket);
  }
  return [...byTerms.entries()].map(([key, bucket]) =>
    syntheticOverride(
      `${MODEL_ACCESS_OVERRIDE_PREFIX}${dimension}|${list}|${key}`,
      LIST_SCOPE[list],
      bucket.targets,
      grantEntries(rule, bucket.requests),
    ),
  );
}

function denyOverride(rule: ModelAccessRule): LimitOverride[] {
  const targets = [
    ...new Set(
      rule.deny.map((mail) => mail.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (targets.length === 0) return [];
  return [
    syntheticOverride(
      `${MODEL_ACCESS_OVERRIDE_PREFIX}${modelAccessDimension(rule)}|deny|all`,
      'user',
      targets,
      [entry(rule, 'model.allowed', false)],
    ),
  ];
}

export interface ExpandedModelAccess {
  defaults: LimitEntry[];
  overrides: LimitOverride[];
}

/** Pure expansion of every rule; deterministic order (rule order, list order). */
export function expandModelAccess(
  rules: readonly ModelAccessRule[] | undefined,
): ExpandedModelAccess {
  const defaults: LimitEntry[] = [];
  const overrides: LimitOverride[] = [];
  for (const rule of rules ?? []) {
    if (!rule.modelId && !rule.series) continue;
    defaults.push(...defaultEntries(rule));
    overrides.push(
      ...grantOverrides(rule, 'groups'),
      ...grantOverrides(rule, 'domains'),
      ...grantOverrides(rule, 'allow'),
      ...denyOverride(rule),
    );
  }
  return { defaults, overrides };
}

/** `limitKey|modelId|series` — the cell key the policy PUT dedupes defaults on. */
export function defaultCellKey(
  entry: Pick<LimitEntry, 'limitKey' | 'modelId' | 'series'>,
): string {
  return `${entry.limitKey}|${entry.modelId?.toLowerCase() ?? ''}|${entry.series?.toLowerCase() ?? ''}`;
}
