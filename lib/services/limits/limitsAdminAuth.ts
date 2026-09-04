/**
 * Limits admin identity: global admin OR scoped admin.
 *
 * Mirrors `resolveAdminStatus` in lib/services/agentAccess/adminAuth.ts, but
 * for the usage-limits admin model, which is deliberately independent
 * (design docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6d): a scoped limits admin is
 * someone named in ≥1 ENABLED delegation of the limits policy, and that grant
 * must never be expressed through `AdminStatus.isLocalAdmin`, which would hand
 * them agents/connectors/guides/map-datasets.
 *
 * Ownership for authorization is delegation membership (`delegation.admins`),
 * never an override's `createdBy` — an admin can be moved between delegations
 * and mail can change (design §2).
 *
 * View-as: a REAL global admin demoted with `adminRole: 'local'` is treated as
 * named in exactly `viewAs.overrides.limitDelegationIds` ∩ enabled delegation
 * ids — never in delegations that list their real mail, or "view as a regular
 * user" would still leave them a scoped admin. `adminRole: 'none'` → nothing.
 * The cookie itself is only ever honoured for a real global admin
 * (lib/services/admin/viewAs.ts), so the demotion branch is unreachable for
 * anyone else — but be explicit, as resolveAdminStatus is.
 *
 * Pure: typed against `MinimalDelegation` (the three fields this decision
 * needs) so the full `LimitsPolicy` document and any `LimitDelegation`
 * structurally satisfy it, and so this module has no storage imports.
 */
import {
  AdminIdentity,
  demotedRole,
  isRealGlobalAdmin,
  mailOf,
} from '@/lib/services/agentAccess/adminAuth';

export interface LimitsAdminStatus {
  isGlobalAdmin: boolean;
  isScopedAdmin: boolean;
  /**
   * Ids of ENABLED delegations naming this admin; [] for global admins (they
   * do not act "under" a delegation) and for non-admins.
   */
  delegationIds: string[];
}

/** The subset of LimitDelegation this decision reads. */
export interface MinimalDelegation {
  id: string;
  enabled: boolean;
  /** Graph `mail` values; compared canonicalized (trim + lowercase) here anyway. */
  admins: string[];
}

const NOT_ADMIN: LimitsAdminStatus = {
  isGlobalAdmin: false,
  isScopedAdmin: false,
  delegationIds: [],
};

function enabledDelegationIds(
  policy: { delegations?: MinimalDelegation[] } | null,
): Set<string> {
  return new Set(
    (policy?.delegations ?? []).filter((d) => d.enabled).map((d) => d.id),
  );
}

export function resolveLimitsAdminStatus(
  identity: AdminIdentity,
  policy: { delegations?: MinimalDelegation[] } | null,
): LimitsAdminStatus {
  const mail = mailOf(identity);
  const demoted = demotedRole(identity);

  if (demoted && isRealGlobalAdmin(mail)) {
    if (demoted === 'none') return { ...NOT_ADMIN };
    const requested =
      typeof identity === 'object' && identity !== null
        ? (identity.viewAs?.overrides.limitDelegationIds ?? [])
        : [];
    const enabled = enabledDelegationIds(policy);
    const delegationIds = [
      ...new Set(
        requested.map((id) => id.trim()).filter((id) => enabled.has(id)),
      ),
    ];
    return {
      isGlobalAdmin: false,
      isScopedAdmin: delegationIds.length > 0,
      delegationIds,
    };
  }

  if (isRealGlobalAdmin(mail)) {
    return { isGlobalAdmin: true, isScopedAdmin: false, delegationIds: [] };
  }

  const normalized = mail?.trim().toLowerCase();
  if (!normalized || !policy) return { ...NOT_ADMIN };

  const delegationIds: string[] = [];
  for (const delegation of policy.delegations ?? []) {
    if (!delegation.enabled) continue;
    if (
      delegation.admins.some(
        (admin) => admin.trim().toLowerCase() === normalized,
      ) &&
      !delegationIds.includes(delegation.id)
    ) {
      delegationIds.push(delegation.id);
    }
  }
  return {
    isGlobalAdmin: false,
    isScopedAdmin: delegationIds.length > 0,
    delegationIds,
  };
}
