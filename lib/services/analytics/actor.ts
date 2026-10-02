/**
 * The person an analytics request is answered for. Server-only.
 *
 * Built from the session USER, so "view as" applies everywhere: an admin
 * viewing as a member of a group sees exactly that group's folders, and a
 * demoted admin is not an analytics admin.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AnalyticsActor } from '@/lib/services/analytics/access';
import {
  isAnalyticsAdmin,
  resolveAnalyticsAdmin,
} from '@/lib/services/analytics/adminAccess';
import { buildPrincipal } from '@/lib/services/limits/principal';
import {
  isGroupMembershipDegradedForUser,
  resolveUserGroupIds,
} from '@/lib/services/m365/groupMembership';

export interface ResolvedAnalyticsActor {
  actor: AnalyticsActor;
  /** Group membership could not be read: group-granted folders are missing. */
  groupsDegraded: boolean;
}

export async function resolveAnalyticsActor(
  request: NextRequest,
  session: Session,
): Promise<ResolvedAnalyticsActor> {
  // MUST precede buildPrincipal: group-scoped audiences read the membership
  // cache synchronously, and a cold cache grants nothing. Never throws.
  await resolveUserGroupIds(request, session);
  const { status } = await resolveAnalyticsAdmin(session.user);
  return {
    actor: {
      principal: buildPrincipal(session),
      isGlobalAdmin: status.isGlobalAdmin,
      isAnalyticsAdmin: isAnalyticsAdmin(status),
    },
    groupsDegraded: isGroupMembershipDegradedForUser(session.user.id),
  };
}
