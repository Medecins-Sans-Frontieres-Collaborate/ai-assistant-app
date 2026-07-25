/**
 * Limit resolution — pure, I/O-free, and the whole of the precedence
 * contract. See docs/LIMITS.md.
 *
 * Resolution runs per limit KEY, not per record. That sparse merge is the
 * crux: a user override that sets only `chat.messagesPerDay` must not erase
 * a domain override of `feature.tts.charactersPerDay`.
 *
 * Layer ranks (total, no ambiguity):
 *   catalog(0) < global(1) < domain(2) < attribute(3) < group(4) < user(5)
 *
 * "Most specific wins", so a user-level override may RAISE, lower, or set
 * unlimited — an exception that cannot grant more is not an exception. A
 * global admin who needs a cap nothing may exceed ticks `ceiling` on the
 * global default instead.
 */
import {
  LimitEntry,
  LimitOverride,
  LimitValue,
  LimitsPolicy,
  OverrideScope,
} from '@/lib/services/limits/types';
import {
  Principal,
  matchesPrincipal,
} from '@/lib/services/shared/principalMatching';

import {
  LIMIT_DEFINITIONS,
  LimitDefinition,
  getLimitDefinition,
  isValidDimension,
} from '@/config/limits';

export type LimitSource =
  | 'catalog'
  | 'global'
  | 'domain'
  | 'attribute'
  | 'group'
  | 'user';

const LAYER_RANK: Record<LimitSource, number> = {
  catalog: 0,
  global: 1,
  domain: 2,
  attribute: 3,
  group: 4,
  user: 5,
};

/** Override scopes map 1:1 onto the layers above `global`. */
const SCOPE_TO_SOURCE: Record<OverrideScope, LimitSource> = {
  user: 'user',
  domain: 'domain',
  attribute: 'attribute',
  group: 'group',
};

export interface ResolvedLimit {
  limitKey: string;
  /** null = unlimited. */
  value: LimitValue;
  unit: LimitDefinition['unit'];
  kind: LimitDefinition['kind'];
  window: LimitDefinition['window'];
  /** Which layer won — surfaced in the admin "why" preview and the audit log. */
  source: LimitSource;
  /** The winning override's id, when a non-global layer won. */
  overrideId?: string;
  /** A global `ceiling: true` default clamped the winner down. */
  ceilingApplied?: boolean;
  /** The compiled `hardCeiling` clamped the winner down. */
  hardCeilingApplied?: boolean;
  /** Set when this cell is qualified by a model id or series. */
  modelId?: string;
  series?: string;
}

/**
 * Restrictiveness ordering used only as a same-rank tie-break:
 *   false < 0 < 1 < … < n < null (unlimited) < true
 * `null` is +Infinity because unlimited is the least restrictive number, and
 * `true` sits above it because a boolean "allowed" imposes nothing at all.
 */
function restrictiveness(value: LimitValue): number {
  if (value === false) return -1;
  if (value === true) return Number.POSITIVE_INFINITY;
  if (value === null) return Number.MAX_SAFE_INTEGER;
  return value;
}

/** Within a layer: an exact model id beats a series beats an unqualified entry. */
function qualifierSpecificity(entry: LimitEntry): number {
  if (entry.modelId) return 2;
  if (entry.series) return 1;
  return 0;
}

/**
 * Does this entry speak to the cell being resolved? An entry qualified by a
 * model id only applies to that model; an unqualified entry applies to all.
 */
function entryAppliesTo(
  entry: LimitEntry,
  limitKey: string,
  modelId?: string,
  series?: string,
): boolean {
  if (entry.limitKey !== limitKey) return false;
  if (entry.modelId) {
    return !!modelId && entry.modelId.toLowerCase() === modelId.toLowerCase();
  }
  if (entry.series) {
    return !!series && entry.series.toLowerCase() === series.toLowerCase();
  }
  return true;
}

interface Candidate {
  value: LimitValue;
  source: LimitSource;
  priority: number;
  specificity: number;
  overrideId?: string;
}

/**
 * The TOTAL comparator. Applied in order until one criterion differentiates,
 * so the outcome is stable across replicas, refreshes, and any shuffling of
 * the stored override array — which is what makes the provenance shown in
 * the admin preview trustworthy.
 */
function beats(a: Candidate, b: Candidate): boolean {
  // a. Layer specificity.
  if (LAYER_RANK[a.source] !== LAYER_RANK[b.source]) {
    return LAYER_RANK[a.source] > LAYER_RANK[b.source];
  }
  // b. Admin's explicit tie-break lever.
  if (a.priority !== b.priority) return a.priority > b.priority;
  // c. Qualifier specificity within the layer (modelId > series > none).
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  // d. More restrictive wins — settles two same-rank policies (two domains,
  //    later two groups) deterministically rather than by array order.
  const ra = restrictiveness(a.value);
  const rb = restrictiveness(b.value);
  if (ra !== rb) return ra < rb;
  // e. Lexicographically smallest id — total even for identical records.
  return (a.overrideId ?? '') < (b.overrideId ?? '');
}

function clampNumeric(value: LimitValue, ceiling: LimitValue): LimitValue {
  const limit = restrictiveness(ceiling);
  const current = restrictiveness(value);
  if (current <= limit) return value;
  return ceiling;
}

function pickGlobalEntry(
  policy: LimitsPolicy | null,
  limitKey: string,
  modelId?: string,
  series?: string,
): LimitEntry | undefined {
  if (!policy) return undefined;
  let winner: LimitEntry | undefined;
  for (const entry of policy.defaults) {
    if (!entryAppliesTo(entry, limitKey, modelId, series)) continue;
    if (
      !winner ||
      qualifierSpecificity(entry) > qualifierSpecificity(winner) ||
      (qualifierSpecificity(entry) === qualifierSpecificity(winner) &&
        restrictiveness(entry.value) < restrictiveness(winner.value))
    ) {
      winner = entry;
    }
  }
  return winner;
}

function matchingOverrides(
  policy: LimitsPolicy | null,
  principal: Principal,
): LimitOverride[] {
  if (!policy) return [];
  return policy.overrides.filter(
    (override) =>
      override.enabled &&
      matchesPrincipal(principal, override.scope, override.targets),
  );
}

/**
 * Resolves one limit cell. `modelId`/`series` select which per-model cell is
 * being asked about; a model that declares no series simply never produces a
 * `family:` cell (see resolveModelCells).
 */
export function resolveLimit(
  def: LimitDefinition,
  policy: LimitsPolicy | null,
  principal: Principal,
  modelId?: string,
  series?: string,
): ResolvedLimit {
  // 1. Seed from the compiled catalog.
  let winner: Candidate = {
    value: def.defaultValue,
    source: 'catalog',
    priority: 0,
    specificity: 0,
  };

  // 2. Global defaults.
  const globalEntry = pickGlobalEntry(policy, def.key, modelId, series);
  if (globalEntry) {
    winner = {
      value: globalEntry.value,
      source: 'global',
      priority: 0,
      specificity: qualifierSpecificity(globalEntry),
    };
  }

  // 3-4. Overrides, sparse: only entries that MENTION this key compete. An
  //      absent key is silence and defers to the layer below.
  for (const override of matchingOverrides(policy, principal)) {
    for (const entry of override.entries) {
      if (!entryAppliesTo(entry, def.key, modelId, series)) continue;
      const candidate: Candidate = {
        value: entry.value,
        source: SCOPE_TO_SOURCE[override.scope],
        priority: override.priority,
        specificity: qualifierSpecificity(entry),
        overrideId: override.id,
      };
      if (beats(candidate, winner)) winner = candidate;
    }
  }

  const resolved: ResolvedLimit = {
    limitKey: def.key,
    value: winner.value,
    unit: def.unit,
    kind: def.kind,
    window: def.window,
    source: winner.source,
    ...(winner.overrideId ? { overrideId: winner.overrideId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(series ? { series } : {}),
  };

  // 5. Admin ceiling: a GLOBAL default marked `ceiling` clamps everything
  //    above it. This is how a global admin says "no exception may exceed".
  if (globalEntry?.ceiling) {
    const clamped = clampNumeric(resolved.value, globalEntry.value);
    if (clamped !== resolved.value) {
      resolved.value = clamped;
      resolved.ceilingApplied = true;
    }
  }

  // 6. Compiled hard ceiling, last and unraisable — it encodes a real
  //    provider/app constraint, not a policy preference.
  if (def.hardCeiling !== undefined && typeof resolved.value === 'number') {
    if (resolved.value > def.hardCeiling) {
      resolved.value = def.hardCeiling;
      resolved.hardCeilingApplied = true;
    }
  }
  // An unlimited value on a key with a compiled ceiling still means "the
  // compiled ceiling" — there is no such thing as an unbounded upload.
  if (def.hardCeiling !== undefined && resolved.value === null) {
    resolved.value = def.hardCeiling;
    resolved.hardCeilingApplied = true;
  }

  return resolved;
}

/** Resolves every catalog key for a principal. Used by /api/limits/me. */
export function resolveAllLimits(
  policy: LimitsPolicy | null,
  principal: Principal,
  modelId?: string,
  series?: string,
): Record<string, ResolvedLimit> {
  const out: Record<string, ResolvedLimit> = {};
  for (const def of LIMIT_DEFINITIONS) {
    out[def.key] = resolveLimit(def, policy, principal, modelId, series);
  }
  return out;
}

/**
 * The cells a chat request on `modelId` must satisfy for a per-model key.
 * CONJUNCTIVE, not shadowing: a family cap is an envelope and a model cap a
 * sub-cap, so "cap GPT-5.2 at 50 and everything GPT at 500" is expressible
 * and means exactly what an admin expects.
 *
 * A model with no `series` (optional on OpenAIModel) produces NO family cell
 * — it is never silently folded into another family.
 */
export function resolveModelCells(
  def: LimitDefinition,
  policy: LimitsPolicy | null,
  principal: Principal,
  modelId: string | undefined,
  series: string | undefined,
): ResolvedLimit[] {
  const cells: ResolvedLimit[] = [];
  if (modelId && isValidDimension(modelId)) {
    cells.push(resolveLimit(def, policy, principal, modelId, undefined));
  }
  if (series && isValidDimension(series)) {
    cells.push(resolveLimit(def, policy, principal, undefined, series));
  }
  return cells;
}

export function isUnlimited(resolved: ResolvedLimit | undefined): boolean {
  return !resolved || resolved.value === null || resolved.value === true;
}

/** Convenience for boolean gates: `false` means blocked. */
export function isBlocked(resolved: ResolvedLimit | undefined): boolean {
  return resolved?.value === false;
}

export function limitDefinitionFor(key: string): LimitDefinition | undefined {
  return getLimitDefinition(key);
}
