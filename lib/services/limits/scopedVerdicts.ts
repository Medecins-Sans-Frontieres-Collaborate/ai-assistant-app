/**
 * Save-time verdicts for scoped (delegated) limit overrides —
 * docs/LIMITS_SCOPED_ADMINS_DESIGN.md §4, as amended after review.
 *
 * These are UX, not the control. Containment is enforced by the resolver at
 * evaluation time (§3a): a scoped override can never affect anyone outside
 * its delegation's jurisdiction whatever its `targets` say. What this module
 * adds is the *explanation* — which targets are provably outside (refused,
 * so an override that matches nobody is never stored as a trap for the next
 * admin), which are provably inside, and which only the runtime can decide.
 *
 * Decidability rule: a `user` or `domain` target is provably outside ONLY
 * when the jurisdiction has no `group` and no `attribute` predicate (both are
 * opaque to a static check — membership and session attributes live on the
 * target) and the target fails every `domain`/`user` predicate. Otherwise the
 * verdict is `undecidable` and the caller allows + warns. `group` and
 * `attribute` targets are always cross-axis (health ∩ OCP is the only
 * sensible meaning) unless the jurisdiction names the very same target.
 *
 * Pure and client-safe (no node builtins): the editor renders these same
 * verdicts at authoring time, and the server computes them on GET for the
 * post-narrowing chip — one implementation, never two that drift.
 */
import { resolveLimit } from '@/lib/services/limits/resolver';
import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitValue,
  LimitsPolicy,
  OverrideScope,
} from '@/lib/services/limits/types';
import {
  Principal,
  domainOfMail,
  normalizeMail,
} from '@/lib/services/shared/principalMatching';

import { getLimitDefinition } from '@/config/limits';

export type TargetVerdictStatus = 'in-scope' | 'out-of-scope' | 'undecidable';

export type TargetVerdictReason =
  | 'domain-match'
  | 'user-match'
  | 'not-in-domains'
  | 'not-in-users'
  | 'group-or-attribute-jurisdiction'
  | 'cross-axis';

export interface TargetVerdict {
  target: string;
  status: TargetVerdictStatus;
  reason: TargetVerdictReason;
}

/** Warnings the delegations editor and the scoped GET surface per delegation. */
export type JurisdictionWarning = 'no-domain-or-user-anchor';

/** Flags the scoped GET attaches to each override under the caller's delegations. */
export type OverrideFlag = 'out-of-scope-targets' | 'delegation-disabled';

export type PreviewVerdict = 'allowed' | 'outside' | 'undecidable';

/**
 * A jurisdiction folded into lookup sets. Serializable (arrays, not Sets) so
 * the client can render "your scope" from the same shape.
 */
export interface JurisdictionSummary {
  domains: string[];
  users: string[];
  groups: string[];
  attributes: string[];
  /** Any `group` or `attribute` predicate — static verdicts cannot decide. */
  hasOpaque: boolean;
  /** Any `domain` or `user` predicate — the jurisdiction can be evaluated without Graph (§8). */
  anchored: boolean;
}

function canonical(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueCanonical(values: readonly string[]): string[] {
  return [...new Set(values.map(canonical).filter(Boolean))];
}

export function summarizeJurisdiction(
  jurisdiction: readonly JurisdictionPredicate[],
): JurisdictionSummary {
  const buckets: Record<OverrideScope, string[]> = {
    domain: [],
    user: [],
    group: [],
    attribute: [],
  };
  for (const predicate of jurisdiction) {
    buckets[predicate.scope].push(...predicate.targets);
  }
  const domains = uniqueCanonical(buckets.domain);
  const users = uniqueCanonical(buckets.user);
  const groups = uniqueCanonical(buckets.group);
  const attributes = uniqueCanonical(buckets.attribute);
  // Judged on the TARGETS, not the predicate list: a predicate with no
  // targets matches nobody (the editor can hold one mid-edit), so it neither
  // anchors the jurisdiction nor makes anything undecidable.
  return {
    domains,
    users,
    groups,
    attributes,
    hasOpaque: groups.length > 0 || attributes.length > 0,
    anchored: domains.length > 0 || users.length > 0,
  };
}

function judgeOne(
  summary: JurisdictionSummary,
  scope: OverrideScope,
  target: string,
): TargetVerdict {
  const value = canonical(target);
  switch (scope) {
    case 'user': {
      const domain = domainOfMail(value);
      if (domain && summary.domains.includes(domain)) {
        return { target, status: 'in-scope', reason: 'domain-match' };
      }
      if (summary.users.includes(value)) {
        return { target, status: 'in-scope', reason: 'user-match' };
      }
      if (summary.hasOpaque) {
        return {
          target,
          status: 'undecidable',
          reason: 'group-or-attribute-jurisdiction',
        };
      }
      return {
        target,
        status: 'out-of-scope',
        reason: summary.domains.length > 0 ? 'not-in-domains' : 'not-in-users',
      };
    }
    case 'domain': {
      if (summary.domains.includes(value)) {
        return { target, status: 'in-scope', reason: 'domain-match' };
      }
      if (summary.hasOpaque) {
        return {
          target,
          status: 'undecidable',
          reason: 'group-or-attribute-jurisdiction',
        };
      }
      // A domain under a user-only jurisdiction is "not fully inside" — a
      // policy choice (design §4), stated by the reason rather than hidden.
      return {
        target,
        status: 'out-of-scope',
        reason: summary.domains.length > 0 ? 'not-in-domains' : 'not-in-users',
      };
    }
    case 'group':
      if (summary.groups.includes(value)) {
        return {
          target,
          status: 'in-scope',
          reason: 'group-or-attribute-jurisdiction',
        };
      }
      return { target, status: 'undecidable', reason: 'cross-axis' };
    case 'attribute':
      if (summary.attributes.includes(value)) {
        return {
          target,
          status: 'in-scope',
          reason: 'group-or-attribute-jurisdiction',
        };
      }
      return { target, status: 'undecidable', reason: 'cross-axis' };
  }
}

/** One verdict per target, in input order. */
export function judgeTargets(
  jurisdiction: readonly JurisdictionPredicate[],
  scope: OverrideScope,
  targets: readonly string[],
): TargetVerdict[] {
  const summary = summarizeJurisdiction(jurisdiction);
  return targets.map((target) => judgeOne(summary, scope, target));
}

/** The targets a scoped write must refuse (design §4: reject, never store inert). */
export function outOfScopeTargets(
  verdicts: readonly TargetVerdict[],
): string[] {
  return verdicts
    .filter((v) => v.status === 'out-of-scope')
    .map((v) => v.target);
}

/**
 * A jurisdiction with no `domain`/`user` predicate inherits the group
 * cache's failure posture (design §8): on any Graph failure it silently does
 * not apply for 60 s per replica, and a structural failure re-arms that
 * indefinitely. Worth a warning wherever the delegation is shown.
 */
export function jurisdictionWarnings(
  delegation: Pick<LimitDelegation, 'jurisdiction'>,
): JurisdictionWarning[] {
  return summarizeJurisdiction(delegation.jurisdiction).anchored
    ? []
    : ['no-domain-or-user-anchor'];
}

/**
 * Flags for an existing override, computed against the delegation it
 * carries. A missing delegation is treated as disabled (design §8): inert,
 * warned about, never global.
 */
export function overrideFlags(
  override: Pick<LimitOverride, 'scope' | 'targets'>,
  delegation: Pick<LimitDelegation, 'enabled' | 'jurisdiction'> | undefined,
): OverrideFlag[] {
  const flags: OverrideFlag[] = [];
  if (!delegation || !delegation.enabled) flags.push('delegation-disabled');
  if (
    delegation &&
    outOfScopeTargets(
      judgeTargets(delegation.jurisdiction, override.scope, override.targets),
    ).length > 0
  ) {
    flags.push('out-of-scope-targets');
  }
  return flags;
}

/**
 * May a scoped admin preview `mail` (design §6c)? Allowed when the mail's
 * domain is in the union of their delegations' domains or the mail is a
 * listed user. Otherwise `undecidable` when any predicate is opaque (the
 * person may be inside via a group or attribute, which cannot be evaluated
 * for an arbitrary mail), else provably `outside`.
 */
export function canPreviewMail(
  delegations: readonly Pick<LimitDelegation, 'jurisdiction'>[],
  mail: string,
): PreviewVerdict {
  const normalized = normalizeMail(mail);
  const domain = domainOfMail(mail);
  let hasOpaque = false;
  for (const delegation of delegations) {
    const summary = summarizeJurisdiction(delegation.jurisdiction);
    if (domain && summary.domains.includes(domain)) return 'allowed';
    if (normalized && summary.users.includes(normalized)) return 'allowed';
    hasOpaque ||= summary.hasOpaque;
  }
  return hasOpaque ? 'undecidable' : 'outside';
}

// ---------------------------------------------------------------------------
// Audit: how many entries RAISE over the global tier
// ---------------------------------------------------------------------------

/**
 * Same ordering as the resolver's tie-break — false < 0 < … < n < null < true
 * — kept local so this module stays independent of resolver internals.
 */
function restrictiveness(value: LimitValue): number {
  if (value === false) return -1;
  if (value === true) return Number.POSITIVE_INFINITY;
  if (value === null) return Number.MAX_SAFE_INTEGER;
  return value;
}

/** How many targets a raise count inspects — bounds the work per write. */
const RAISE_SAMPLE_TARGETS = 25;

function syntheticPrincipals(
  scope: OverrideScope,
  targets: readonly string[],
): Principal[] {
  const sample = targets.slice(0, RAISE_SAMPLE_TARGETS).map(canonical);
  const blank: Principal = { userId: '', attributes: [], groupIds: [] };
  switch (scope) {
    case 'user':
      return sample.map((mail) => ({
        ...blank,
        mail,
        domain: domainOfMail(mail),
      }));
    case 'domain':
      return sample.map((domain) => ({ ...blank, domain }));
    case 'attribute':
      return [{ ...blank, attributes: sample }];
    case 'group':
      return [{ ...blank, groupIds: sample }];
  }
}

const NO_DELEGATIONS: ReadonlySet<string> = new Set();

/**
 * The audit number the scoped log line carries (design §7): how many of the
 * override's entries are LESS restrictive than what the global tier alone
 * (catalog + defaults + undelegated overrides) would give the targeted
 * people. A delegation is by default authority to lift every non-ceiling
 * limit inside its jurisdiction; this makes each such lift countable.
 *
 * Evaluated against synthetic principals built from the targets (a sample of
 * at most 25), with every scoped record excluded so the comparison is purely
 * "versus the global tier". Approximate by construction — attributes and
 * groups of the real people are unknown here — but deterministic.
 */
export function countRaises(
  policy: LimitsPolicy,
  override: Pick<LimitOverride, 'scope' | 'targets' | 'entries'>,
): number {
  const globalOnly: LimitsPolicy = {
    ...policy,
    overrides: policy.overrides.filter((o) => !o.delegationId),
  };
  const principals = syntheticPrincipals(override.scope, override.targets);
  if (principals.length === 0) return 0;
  let raises = 0;
  for (const entry of override.entries as LimitEntry[]) {
    const def = getLimitDefinition(entry.limitKey);
    if (!def) continue;
    const proposed = restrictiveness(entry.value);
    const raised = principals.some((principal) => {
      const base = resolveLimit(
        def,
        globalOnly,
        principal,
        entry.modelId,
        entry.series,
        NO_DELEGATIONS,
      );
      return proposed > restrictiveness(base.value);
    });
    if (raised) raises += 1;
  }
  return raises;
}
