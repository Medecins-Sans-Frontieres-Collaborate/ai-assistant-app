/**
 * Limit resolution — pure, I/O-free, and the whole of the precedence
 * contract. See docs/LIMITS.md and docs/LIMITS_SCOPED_ADMINS_DESIGN.md §3.
 *
 * Resolution runs per limit KEY, not per record. That sparse merge is the
 * crux: a user override that sets only `chat.messagesPerDay` must not erase
 * a domain override of `feature.tts.charactersPerDay`.
 *
 * Layer ranks (total, no ambiguity):
 *   catalog(0) < global(1) < domain(2) < attribute(3) < group(4) < user(5)
 *
 * Within a layer the comparator continues
 *   tier (global > scoped) → priority → qualifier specificity →
 *   restrictiveness → id
 * so at the same layer a global admin's record always outranks a scoped
 * admin's, and `priority` only orders records of the same tier.
 *
 * "Most specific wins", so a user-level override may RAISE, lower, or set
 * unlimited — an exception that cannot grant more is not an exception. A
 * global admin who needs a cap nothing may exceed ticks `ceiling` on a
 * global-tier record instead; the most specific ceiling that applies to the
 * cell pins it.
 *
 * CONTAINMENT (the security property): an override that carries a
 * `delegationId` competes ONLY for principals inside that delegation's
 * jurisdiction, whatever its `targets` say. An orphaned or disabled
 * delegation makes its overrides inert — never global. Save-time verdicts
 * are UX; this is the control. The set of delegations a principal is inside
 * is computed ONCE per resolution pass, not per cell.
 *
 * Two rules the resolver enforces by TIER so stored data can never out-vote
 * them: a scoped candidate is compared as `priority: 0`, and a scoped entry
 * is never a ceiling candidate, regardless of the stored values.
 */
import {
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitTier,
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

export type { LimitTier };

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

/** At the same layer, global outranks scoped. */
const TIER_RANK: Record<LimitTier, number> = {
  scoped: 0,
  global: 1,
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
  /**
   * Which authority tier the winning record belongs to — `scoped` only when
   * a delegated override won; catalog, global defaults and undelegated
   * overrides are `global`.
   */
  tier: LimitTier;
  /** The winning override's id, when a non-global layer won. */
  overrideId?: string;
  /** A global-tier `ceiling: true` record clamped the winner down. */
  ceilingApplied?: boolean;
  /**
   * The global-tier OVERRIDE whose ceiling pinned the value — for the "why"
   * preview and the audit log. Absent when the global default (or nothing)
   * did the clamping.
   */
  ceilingOverrideId?: string;
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
  tier: LimitTier;
  priority: number;
  specificity: number;
  /** Eligible to pin the cell — already false for every scoped record. */
  ceiling: boolean;
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
  // b. Authority tier: at the same layer a global admin's record outranks a
  //    scoped admin's, so `priority` below only orders records of one tier.
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) {
    return TIER_RANK[a.tier] > TIER_RANK[b.tier];
  }
  // c. Admin's explicit tie-break lever.
  if (a.priority !== b.priority) return a.priority > b.priority;
  // d. Qualifier specificity within the layer (modelId > series > none).
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  // e. More restrictive wins — settles two same-rank policies (two domains,
  //    two overlapping delegations) deterministically rather than by array
  //    order.
  const ra = restrictiveness(a.value);
  const rb = restrictiveness(b.value);
  if (ra !== rb) return ra < rb;
  // f. Lexicographically smallest id — total even for identical records.
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

// ---------------------------------------------------------------------------
// Jurisdictions
// ---------------------------------------------------------------------------

/**
 * A group-anchored jurisdiction that did NOT match a principal whose group
 * list is empty. The resolver cannot tell "not a member" from "membership
 * never loaded" — only the server's group cache knows — so it reports the
 * structural fact and lets the registered hook decide whether to audit it.
 */
export interface JurisdictionUnevaluableEvent {
  delegationId: string;
  userId: string;
}

export type JurisdictionUnevaluableHook = (
  event: JurisdictionUnevaluableEvent,
) => void;

let jurisdictionUnevaluableHook: JurisdictionUnevaluableHook | undefined;

/**
 * Server wiring for the §8 audit line. The resolver must stay pure and
 * client-importable — no Node imports, no logging of its own — while both
 * the degraded-membership check (lib/services/m365/groupMembership.ts) and
 * the log sanitizer (lib/utils/server/log) are server modules. So the server
 * registers a hook here (lib/services/limits/principal.ts) that consults the
 * cache and writes the `[limits-audit] jurisdiction-unevaluable` line through
 * `sanitizeForLog`. Unset (the default) → nothing is reported; resolution is
 * unchanged either way.
 */
export function setJurisdictionUnevaluableHook(
  hook: JurisdictionUnevaluableHook | undefined,
): void {
  jurisdictionUnevaluableHook = hook;
}

/**
 * Is `principal` inside this delegation's jurisdiction? The predicates are
 * OR'd; an empty jurisdiction matches nobody. Does NOT consult `enabled` —
 * that is {@link activeDelegationIds}' job.
 */
export function withinJurisdiction(
  delegation: LimitDelegation,
  principal: Principal,
): boolean {
  return delegation.jurisdiction.some((predicate) =>
    matchesPrincipal(principal, predicate.scope, predicate.targets),
  );
}

/**
 * The ENABLED delegations whose jurisdiction contains `principal` — the set
 * a scoped override's `delegationId` must be in to compete. Computed once per
 * resolution pass and threaded through, never per cell.
 *
 * Group-anchored jurisdictions read `principal.groupIds`, which is [] when
 * the membership cache is cold or degraded (design §8): such a delegation
 * then silently does not apply. When that is the ONLY way it could have
 * failed (the jurisdiction has a group predicate and the principal has no
 * groups at all), the registered hook is told once per delegation per pass so
 * the server can audit the asymmetry (a scoped cap that LOWERS fails open).
 */
export function activeDelegationIds(
  policy: LimitsPolicy | null,
  principal: Principal,
): Set<string> {
  const active = new Set<string>();
  if (!policy) return active;
  for (const delegation of policy.delegations) {
    if (!delegation.enabled) continue;
    if (withinJurisdiction(delegation, principal)) {
      active.add(delegation.id);
      continue;
    }
    if (
      jurisdictionUnevaluableHook &&
      principal.groupIds.length === 0 &&
      delegation.jurisdiction.some((p) => p.scope === 'group')
    ) {
      jurisdictionUnevaluableHook({
        delegationId: delegation.id,
        userId: principal.userId,
      });
    }
  }
  return active;
}

/** Global tier always competes; a scoped record only inside its delegation. */
function withinDelegation(
  delegationId: string | undefined,
  active: ReadonlySet<string>,
): boolean {
  if (!delegationId) return true;
  return active.has(delegationId);
}

function matchingOverrides(
  policy: LimitsPolicy | null,
  principal: Principal,
  active: ReadonlySet<string>,
): LimitOverride[] {
  if (!policy) return [];
  return policy.overrides.filter(
    (override) =>
      override.enabled &&
      matchesPrincipal(principal, override.scope, override.targets) &&
      withinDelegation(override.delegationId, active),
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves one limit cell. `modelId`/`series` select which per-model cell is
 * being asked about; a model that declares no series simply never produces a
 * `family:` cell (see resolveModelCells). `active` is the precomputed
 * {@link activeDelegationIds}; callers resolving many cells pass it so the
 * jurisdiction scan runs once.
 */
export function resolveLimit(
  def: LimitDefinition,
  policy: LimitsPolicy | null,
  principal: Principal,
  modelId?: string,
  series?: string,
  active: ReadonlySet<string> = activeDelegationIds(policy, principal),
): ResolvedLimit {
  // 1. Seed from the compiled catalog.
  let winner: Candidate = {
    value: def.defaultValue,
    source: 'catalog',
    tier: 'global',
    priority: 0,
    specificity: 0,
    ceiling: false,
  };

  // 2. Global defaults. The layer's ONE ceiling candidate is pickGlobalEntry's
  //    winner iff it is flagged — deliberately not "any default with ceiling",
  //    so a qualified non-ceiling default keeps shadowing an unqualified
  //    ceiling default exactly as before delegations existed.
  const globalEntry = pickGlobalEntry(policy, def.key, modelId, series);
  if (globalEntry) {
    winner = {
      value: globalEntry.value,
      source: 'global',
      tier: 'global',
      priority: 0,
      specificity: qualifierSpecificity(globalEntry),
      ceiling: globalEntry.ceiling,
    };
  }
  let ceilingWinner: Candidate | undefined = winner.ceiling
    ? winner
    : undefined;

  // 3-4. Overrides, sparse: only entries that MENTION this key compete. An
  //      absent key is silence and defers to the layer below. A global-tier
  //      entry flagged `ceiling` ALSO competes for "most specific ceiling".
  for (const override of matchingOverrides(policy, principal, active)) {
    const tier: LimitTier = override.delegationId ? 'scoped' : 'global';
    for (const entry of override.entries) {
      if (!entryAppliesTo(entry, def.key, modelId, series)) continue;
      const candidate: Candidate = {
        value: entry.value,
        source: SCOPE_TO_SOURCE[override.scope],
        tier,
        // By tier, not by trust in storage: scoped records never hold the
        // priority lever and never pin a cell, whatever was persisted.
        priority: tier === 'global' ? override.priority : 0,
        specificity: qualifierSpecificity(entry),
        ceiling: tier === 'global' && entry.ceiling,
        overrideId: override.id,
      };
      if (beats(candidate, winner)) winner = candidate;
      if (
        candidate.ceiling &&
        (!ceilingWinner || beats(candidate, ceilingWinner))
      ) {
        ceilingWinner = candidate;
      }
    }
  }

  const resolved: ResolvedLimit = {
    limitKey: def.key,
    value: winner.value,
    unit: def.unit,
    kind: def.kind,
    window: def.window,
    source: winner.source,
    tier: winner.tier,
    ...(winner.overrideId ? { overrideId: winner.overrideId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(series ? { series } : {}),
  };

  // 5. Admin ceiling: the most specific global-tier record marked `ceiling`
  //    clamps everything above it. This is how a global admin says "no
  //    exception — global or scoped — may exceed", while still being able to
  //    grant a more specific exception by ticking `ceiling` on that too.
  if (ceilingWinner) {
    const clamped = clampNumeric(resolved.value, ceilingWinner.value);
    if (clamped !== resolved.value) {
      resolved.value = clamped;
      resolved.ceilingApplied = true;
      if (ceilingWinner.overrideId) {
        resolved.ceilingOverrideId = ceilingWinner.overrideId;
      }
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
  const active = activeDelegationIds(policy, principal);
  const out: Record<string, ResolvedLimit> = {};
  for (const def of LIMIT_DEFINITIONS) {
    out[def.key] = resolveLimit(
      def,
      policy,
      principal,
      modelId,
      series,
      active,
    );
  }
  return out;
}

/**
 * The counter cell a resolved limit debits — and the key the admin preview
 * reads usage back under. Per-model limits are counted separately per model
 * id and per series (`model:gpt-5.2.requests`, `family:gpt.requests`) so a
 * family cap can act as an envelope over its members; everything else uses
 * the bare limit key. ONE definition, shared by the debit path
 * (Middleware.ts) and the usage preview (EffectiveLimitsPreview.tsx): the two
 * previously spelled the key differently and every per-model row read back
 * as "no usage".
 */
export function counterCellName(
  cell: Pick<ResolvedLimit, 'limitKey' | 'modelId' | 'series'>,
): string {
  const suffix = cell.limitKey.split('.').pop();
  if (cell.modelId) return `model:${cell.modelId.toLowerCase()}.${suffix}`;
  if (cell.series) return `family:${cell.series.toLowerCase()}.${suffix}`;
  return cell.limitKey;
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
  const active = activeDelegationIds(policy, principal);
  const cells: ResolvedLimit[] = [];
  if (modelId && isValidDimension(modelId)) {
    cells.push(
      resolveLimit(def, policy, principal, modelId, undefined, active),
    );
  }
  if (series && isValidDimension(series)) {
    cells.push(resolveLimit(def, policy, principal, undefined, series, active));
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
