/**
 * Builds the {@link Principal} that limit overrides are matched against.
 *
 * Two identity keys, deliberately different:
 *  - `userId` (Entra oid) keys USAGE COUNTERS. It is stable, so a mail
 *    rename cannot silently reset someone's quota.
 *  - `mail` keys POLICY TARGETING, because that is what an admin types.
 *
 * The `attribute` scope is what actually delivers the "groups" override axis
 * today: real Entra group membership is not on the session (pending tenant
 * consent — see docs/M365_GRAPH_PERMISSIONS_REQUEST.md), whereas
 * `department` / `companyName` / `officeId` are, and in most orgs "group" in
 * an admin's head means "the Health department".
 */
import { Session } from 'next-auth';

import { setJurisdictionUnevaluableHook } from '@/lib/services/limits/resolver';
import {
  getCachedGroupIdsForUser,
  isGroupMembershipDegradedForUser,
} from '@/lib/services/m365/groupMembership';
import {
  Principal,
  domainOfMail,
  normalizeMail,
} from '@/lib/services/shared/principalMatching';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export type { Principal };

// Server-side wiring for the resolver's §8 audit line (docs/
// LIMITS_SCOPED_ADMINS_DESIGN.md): a group-anchored jurisdiction that fails
// only because the principal's groups are empty AND membership is marked
// degraded logs `[limits-audit] jurisdiction-unevaluable`. The resolver is
// pure and client-importable, so it can neither import groupMembership.ts nor
// the log sanitizer; it reports the structural fact and this hook decides.
// This module is the server-only seam every limits route already passes
// through to build a Principal, which makes it the natural registration point.
// Both interpolated values are sanitized (CWE-117): the delegation id is
// schema-validated but the oid comes off the session.
setJurisdictionUnevaluableHook(({ delegationId, userId }) => {
  if (!isGroupMembershipDegradedForUser(userId)) return;
  console.warn(
    `[limits-audit] jurisdiction-unevaluable delegation=${sanitizeForLog(delegationId)} user=${sanitizeForLog(userId)} reason=group-membership-degraded`,
  );
});

/** Attribute target prefixes, also used by the admin UI to build pickers. */
export const ATTRIBUTE_PREFIXES = {
  department: 'department',
  company: 'company',
  office: 'office',
} as const;

function attributeTarget(prefix: string, value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? `${prefix}:${normalized}` : null;
}

export function buildPrincipal(session: Session | null): Principal {
  const user = session?.user;
  const mail = normalizeMail(user?.mail);
  const attributes = [
    attributeTarget(ATTRIBUTE_PREFIXES.department, user?.department),
    attributeTarget(ATTRIBUTE_PREFIXES.company, user?.companyName),
    attributeTarget(ATTRIBUTE_PREFIXES.office, user?.officeId),
  ].filter((v): v is string => v !== null);

  return {
    userId: user?.id ?? '',
    mail,
    domain: domainOfMail(user?.mail),
    attributes,
    // View-as (admin test mode) replaces membership outright; otherwise a
    // sync cache read: [] until a route warms it via resolveUserGroupIds
    // (see lib/services/m365/groupMembership.ts for the posture).
    groupIds:
      user?.viewAs?.overrides.groupIds ??
      (user?.id ? getCachedGroupIdsForUser(user.id) : []),
  };
}
