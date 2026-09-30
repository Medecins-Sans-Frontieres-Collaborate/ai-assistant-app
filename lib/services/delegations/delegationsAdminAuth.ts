/**
 * "Does this person hold grant G in some delegation?" — the delegated half of
 * an admin gate, for capabilities served through DelegationsService
 * (announcements today). Usage limits keeps its own resolver
 * (`resolveLimitsAdminStatus`), fed the composed `LimitDelegation[]`; the two
 * answer the same question through the same data, and `adminAreas.ts` stays a
 * union of independent gates — a grant model feeds the gates, it does not
 * collapse them.
 *
 * View-as mirrors limitsAdminAuth: a REAL global admin demoted to `local` is
 * treated as holding the grant in exactly the delegation ids the view-as
 * cookie names (∩ enabled delegations offering the grant) — never in the
 * delegations that list their real mail. `none` → nothing.
 *
 * Pure: no storage imports.
 */
import {
  AdminIdentity,
  demotedRole,
  isRealGlobalAdmin,
  mailOf,
} from '@/lib/services/agentAccess/adminAuth';
import {
  DelegationGrant,
  SharedDelegation,
  adminHoldsGrant,
} from '@/lib/services/delegations/types';

export interface DelegatedAdminStatus {
  isGlobalAdmin: boolean;
  isDelegatedAdmin: boolean;
  /** Enabled delegations in which the person holds the grant; [] for globals. */
  delegationIds: string[];
}

const NOT_ADMIN: DelegatedAdminStatus = {
  isGlobalAdmin: false,
  isDelegatedAdmin: false,
  delegationIds: [],
};

export function resolveDelegatedAdminStatus(
  identity: AdminIdentity,
  delegations: readonly SharedDelegation[] | null,
  grant: DelegationGrant,
): DelegatedAdminStatus {
  const mail = mailOf(identity);
  const demoted = demotedRole(identity);
  const offering = (delegations ?? []).filter(
    (d) => d.enabled && d.capabilities.includes(grant),
  );

  if (demoted && isRealGlobalAdmin(mail)) {
    if (demoted === 'none') return { ...NOT_ADMIN };
    const requested =
      typeof identity === 'object' && identity !== null
        ? (identity.viewAs?.overrides.limitDelegationIds ?? [])
        : [];
    const offered = new Set(offering.map((d) => d.id));
    const delegationIds = [
      ...new Set(
        requested.map((id) => id.trim()).filter((id) => offered.has(id)),
      ),
    ];
    return {
      isGlobalAdmin: false,
      isDelegatedAdmin: delegationIds.length > 0,
      delegationIds,
    };
  }

  if (isRealGlobalAdmin(mail)) {
    return { isGlobalAdmin: true, isDelegatedAdmin: false, delegationIds: [] };
  }

  const delegationIds = offering
    .filter((d) => adminHoldsGrant(d, mail, grant))
    .map((d) => d.id);
  return {
    isGlobalAdmin: false,
    isDelegatedAdmin: delegationIds.length > 0,
    delegationIds,
  };
}
