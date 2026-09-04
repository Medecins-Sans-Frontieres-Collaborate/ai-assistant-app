/**
 * Client-side jurisdiction helpers for the limits admin panel — pure, no
 * node builtins, no React.
 *
 * Three questions the panel answers BEFORE a save round-trips:
 *   1. §4 save-time verdicts for a draft's targets, so a scoped admin is told
 *      "outside your scope" while typing and not after (design §6b). The
 *      rules are NOT re-implemented here: they are imported from
 *      lib/services/limits/scopedVerdicts.ts, the same module the server runs
 *      on GET and on every scoped write, so client and server cannot drift.
 *      The server is still the authority; this is UX, and the resolver's
 *      containment (§3a) is the control.
 *   2. Overlap between delegations (design §6a): same target in two
 *      jurisdictions, or a listed user whose domain another delegation
 *      holds. Group-vs-domain is NEVER reported: membership is opaque, and a
 *      false positive trains admins to ignore the hint.
 *   3. "Other rules relevant to the same targets" for the hover/click
 *      affordance on delegation and override cards.
 *
 * Matching reuses principalMatching.ts's mail/domain canonicalisation so
 * there is one definition of "this user matches this rule" in the codebase.
 */
import {
  TargetVerdict,
  judgeTargets,
  outOfScopeTargets,
  summarizeJurisdiction,
} from '@/lib/services/limits/scopedVerdicts';
import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitTier,
  OverrideScope,
} from '@/lib/services/limits/types';
import { domainOfMail } from '@/lib/services/shared/principalMatching';

// ---------------------------------------------------------------------------
// Verdicts — ONE implementation, shared with the server
// ---------------------------------------------------------------------------

/**
 * The §4 rules live in lib/services/limits/scopedVerdicts.ts (pure, client
 * safe) and the server computes verdicts on GET and on every scoped write
 * with the very same functions. Re-exported here so the panel has one import
 * surface; nothing about the rules is re-implemented on the client.
 */
export type {
  JurisdictionSummary,
  TargetVerdict,
  TargetVerdictReason,
  TargetVerdictStatus,
} from '@/lib/services/limits/scopedVerdicts';
export {
  outOfScopeTargets,
  summarizeJurisdiction,
} from '@/lib/services/limits/scopedVerdicts';

function canon(value: string): string {
  return value.trim().toLowerCase();
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(canon).filter((v) => v.length > 0))];
}

/**
 * Anchored = has at least one domain or user target (design §8). A
 * jurisdiction without one inherits the group cache's failure posture and
 * cannot be previewed by mail (§6c).
 */
export function isMailAnchored(
  predicates: readonly JurisdictionPredicate[],
): boolean {
  return summarizeJurisdiction(predicates).anchored;
}

/** Any group or attribute predicate makes user/domain verdicts undecidable. */
export function hasOpaquePredicate(
  predicates: readonly JurisdictionPredicate[],
): boolean {
  return summarizeJurisdiction(predicates).hasOpaque;
}

/** The §4 table, one target at a time — `judgeTargets` for a single target. */
export function verdictForTarget(
  scope: OverrideScope,
  target: string,
  predicates: readonly JurisdictionPredicate[],
): TargetVerdict {
  return judgeTargets(predicates, scope, [target])[0];
}

export function verdictsForTargets(
  scope: OverrideScope,
  targets: readonly string[],
  predicates: readonly JurisdictionPredicate[],
): TargetVerdict[] {
  return judgeTargets(predicates, scope, targets);
}

export function hasUndecidable(verdicts: readonly TargetVerdict[]): boolean {
  return verdicts.some((verdict) => verdict.status === 'undecidable');
}

/**
 * Narrowing preview (design §6a): how many of a delegation's existing
 * overrides carry at least one target PROVABLY outside `jurisdiction`. Used
 * live while the global admin edits the predicates, before save.
 */
export function narrowedOverrideCount(
  jurisdiction: readonly JurisdictionPredicate[],
  overrides: readonly LimitOverride[],
): number {
  return overrides.filter(
    (override) =>
      outOfScopeTargets(
        verdictsForTargets(override.scope, override.targets, jurisdiction),
      ).length > 0,
  ).length;
}

/**
 * Global defaults a scoped admin MAY raise: configured entries without a
 * ceiling whose value is not already the least restrictive one (an unlimited
 * `null` or an allowed `true` cannot be raised, so listing them would be
 * noise). A blocked `false` IS liftable — a scoped record may flip it on.
 */
export function liftableDefaults(
  defaults: readonly LimitEntry[],
): LimitEntry[] {
  return defaults.filter(
    (entry) => !entry.ceiling && entry.value !== null && entry.value !== true,
  );
}

// ---------------------------------------------------------------------------
// Overlap between delegations
// ---------------------------------------------------------------------------

export interface DelegationOverlap {
  /** Delegation ids, in array order (a before b). */
  a: string;
  b: string;
  scope: OverrideScope;
  /** The shared targets (users listed in one whose domain the other holds count as `user`). */
  shared: string[];
}

function intersection(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((value) => set.has(value));
}

/** Users of `users` whose mail domain is one of `domains`. */
function usersInsideDomains(
  users: readonly string[],
  domains: readonly string[],
): string[] {
  if (domains.length === 0) return [];
  const set = new Set(domains);
  return users.filter((mail) => {
    const domain = domainOfMail(mail);
    return domain !== undefined && set.has(domain);
  });
}

/**
 * Every pair of delegations that share a domain, user, group or attribute
 * target, plus the cross-shape case (a user in A whose domain is in B).
 * Same-scope only for groups and attributes. Disabled delegations are
 * included — a disabled overlap is still worth knowing about before it is
 * re-enabled.
 */
export function delegationOverlaps(
  delegations: readonly LimitDelegation[],
): DelegationOverlap[] {
  const summaries = delegations.map((delegation) => ({
    id: delegation.id,
    summary: summarizeJurisdiction(delegation.jurisdiction),
  }));
  const overlaps: DelegationOverlap[] = [];

  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) {
      const a = summaries[i];
      const b = summaries[j];
      const push = (scope: OverrideScope, shared: string[]) => {
        if (shared.length === 0) return;
        const existing = overlaps.find(
          (o) => o.a === a.id && o.b === b.id && o.scope === scope,
        );
        if (existing) {
          existing.shared = uniq([...existing.shared, ...shared]);
        } else {
          overlaps.push({ a: a.id, b: b.id, scope, shared: uniq(shared) });
        }
      };
      push('domain', intersection(a.summary.domains, b.summary.domains));
      push('user', [
        ...intersection(a.summary.users, b.summary.users),
        ...usersInsideDomains(a.summary.users, b.summary.domains),
        ...usersInsideDomains(b.summary.users, a.summary.domains),
      ]);
      push('group', intersection(a.summary.groups, b.summary.groups));
      push(
        'attribute',
        intersection(a.summary.attributes, b.summary.attributes),
      );
    }
  }
  return overlaps;
}

/** The overlaps that involve one delegation. */
export function overlapsFor(
  overlaps: readonly DelegationOverlap[],
  delegationId: string,
): DelegationOverlap[] {
  return overlaps.filter((o) => o.a === delegationId || o.b === delegationId);
}

// ---------------------------------------------------------------------------
// Relevant rules for a set of targets
// ---------------------------------------------------------------------------

export interface RelevantRule {
  kind: 'override' | 'delegation';
  id: string;
  label: string;
  scope: OverrideScope;
  enabled: boolean;
  /** Overrides only. */
  tier?: LimitTier;
  delegationId?: string;
  /** The queried targets this rule also speaks to. */
  matched: string[];
}

export interface RulePool {
  overrides: readonly LimitOverride[];
  delegations: readonly LimitDelegation[];
}

/**
 * Which of `targets` (under `scope`) does a rule with (`ruleScope`,
 * `ruleTargets`) also cover? Same-scope equality for every scope; plus a
 * user target inside a domain rule, and a domain target that contains a
 * user rule's mail. Group/attribute are equality-only.
 */
function matchedTargets(
  scope: OverrideScope,
  targets: readonly string[],
  ruleScope: OverrideScope,
  ruleTargets: readonly string[],
): string[] {
  const rule = uniq(ruleTargets);
  const ruleSet = new Set(rule);
  const canonTargets = targets.map((t) => ({ raw: t, canon: canon(t) }));

  if (scope === ruleScope) {
    return canonTargets.filter((t) => ruleSet.has(t.canon)).map((t) => t.raw);
  }
  if (scope === 'user' && ruleScope === 'domain') {
    return canonTargets
      .filter((t) => {
        const domain = domainOfMail(t.raw);
        return domain !== undefined && ruleSet.has(domain);
      })
      .map((t) => t.raw);
  }
  if (scope === 'domain' && ruleScope === 'user') {
    const ruleDomains = new Set(
      rule.map((mail) => domainOfMail(mail)).filter((d) => d !== undefined),
    );
    return canonTargets
      .filter((t) => ruleDomains.has(t.canon))
      .map((t) => t.raw);
  }
  return [];
}

/**
 * Other overrides and delegations that speak to any of `targets`. `excludeId`
 * removes the record being viewed. Delegations match through any of their
 * predicates; the matched list is deduped per rule.
 */
export function relevantRulesFor(
  scope: OverrideScope,
  targets: readonly string[],
  pool: RulePool,
  excludeId?: string,
): RelevantRule[] {
  const rules: RelevantRule[] = [];
  if (targets.length === 0) return rules;

  for (const override of pool.overrides) {
    if (override.id === excludeId) continue;
    const matched = matchedTargets(
      scope,
      targets,
      override.scope,
      override.targets,
    );
    if (matched.length === 0) continue;
    rules.push({
      kind: 'override',
      id: override.id,
      label: override.label,
      scope: override.scope,
      enabled: override.enabled,
      tier: override.delegationId ? 'scoped' : 'global',
      delegationId: override.delegationId,
      matched: [...new Set(matched)],
    });
  }

  for (const delegation of pool.delegations) {
    if (delegation.id === excludeId) continue;
    const matched = new Set<string>();
    let matchedScope: OverrideScope | undefined;
    for (const predicate of delegation.jurisdiction) {
      const hits = matchedTargets(
        scope,
        targets,
        predicate.scope,
        predicate.targets,
      );
      if (hits.length === 0) continue;
      matchedScope ??= predicate.scope;
      for (const hit of hits) matched.add(hit);
    }
    if (matched.size === 0 || !matchedScope) continue;
    rules.push({
      kind: 'delegation',
      id: delegation.id,
      label: delegation.label,
      scope: matchedScope,
      enabled: delegation.enabled,
      matched: [...matched],
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** The first `max` targets plus how many were left out, for one-line summaries. */
export function summarizeTargets(
  targets: readonly string[],
  max = 3,
): { shown: string[]; more: number } {
  const shown = targets.slice(0, max);
  return { shown, more: Math.max(0, targets.length - shown.length) };
}
