/**
 * Who may read and write under which delegations — the ONE answer the scoped
 * GET, PUT and DELETE (and nothing else) share, so the three cannot diverge.
 *
 * Built on `resolveLimitsAdminStatus` (lib/services/limits/limitsAdminAuth.ts),
 * which already honours view-as demotion: a real global admin demoted with
 * `adminRole: 'local'` acts under exactly `viewAs.overrides.limitDelegationIds`
 * ∩ enabled delegations, and never under delegations naming their real mail.
 *
 * Two visibilities, deliberately different (design §6b):
 *  - READ (`visible`): enabled delegations naming the caller PLUS disabled
 *    ones, so the person who authored the now-inert overrides can still see
 *    the chips and the "delegation disabled" banner.
 *  - WRITE (`writable`): ENABLED delegations only — a disabled delegation
 *    answers 403 to every mutation.
 *
 * A global admin is never denied here (they may also be named in a
 * delegation and write under it); the route decides what an empty view means
 * for them.
 */
import {
  AdminSubject,
  demotedRole,
  isRealGlobalAdmin,
} from '@/lib/services/agentAccess/adminAuth';
import { resolveLimitsAdminStatus } from '@/lib/services/limits/limitsAdminAuth';
import {
  JurisdictionWarning,
  OverrideFlag,
  TargetVerdict,
} from '@/lib/services/limits/scopedVerdicts';
import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitOverride,
  LimitsMode,
  LimitsPolicy,
} from '@/lib/services/limits/types';

// ---------------------------------------------------------------------------
// Wire shapes of GET /api/limits/scoped (the shared contract the client hook
// in client/hooks/settings/useLimitsAdmin.ts mirrors). Kept here rather than
// in the route file so a route module exports only handlers.
// ---------------------------------------------------------------------------

export interface ScopedDelegationView {
  id: string;
  label: string;
  enabled: boolean;
  jurisdiction: JurisdictionPredicate[];
  maxOverrides: number;
  overrideCount: number;
  warnings: JurisdictionWarning[];
}

export type ScopedOverrideView = LimitOverride & {
  delegationId: string;
  verdicts: TargetVerdict[];
  flags: OverrideFlag[];
};

export interface ScopedLimitsView {
  isGlobalAdmin: boolean;
  mode: LimitsMode;
  timezone: string;
  policyUnavailable: boolean;
  delegations: ScopedDelegationView[];
  overrides: ScopedOverrideView[];
}

export interface ScopedCaller {
  /** Canonical (trim + lowercase) mail. */
  mail: string;
  isGlobalAdmin: boolean;
  /** Delegations the caller may READ under, enabled or not, in document order. */
  visible: LimitDelegation[];
  /** Ids of the ENABLED delegations the caller may WRITE under. */
  writable: ReadonlySet<string>;
}

function namesMail(delegation: LimitDelegation, mail: string): boolean {
  return delegation.admins.some((admin) => admin.trim().toLowerCase() === mail);
}

export function resolveScopedCaller(
  identity: AdminSubject,
  policy: LimitsPolicy,
): ScopedCaller {
  const mail = identity.mail?.trim().toLowerCase() ?? '';
  const status = resolveLimitsAdminStatus(identity, policy);

  // View-as demotion: the cookie's delegation ids are the whole story — a
  // demoted admin must not see delegations naming their real mail, or
  // "view as a regular user" would still leave them a scoped admin.
  if (demotedRole(identity) && isRealGlobalAdmin(mail)) {
    const ids = new Set(status.delegationIds);
    return {
      mail,
      isGlobalAdmin: false,
      visible: policy.delegations.filter((d) => ids.has(d.id)),
      writable: ids,
    };
  }

  const named = policy.delegations.filter((d) => namesMail(d, mail));
  return {
    mail,
    isGlobalAdmin: status.isGlobalAdmin,
    visible: named,
    writable: new Set(named.filter((d) => d.enabled).map((d) => d.id)),
  };
}
