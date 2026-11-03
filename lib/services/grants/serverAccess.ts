/**
 * Server-side grants gate: Entra group membership (access.ts) and the admin
 * workflow policy. Every grants API route goes through here, so an admin
 * switching the grants workflow off takes effect on the API within the
 * policy cache TTL, even for group members.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { canAccessGrants } from '@/lib/services/grants/access';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

export async function hasGrantsAccess(
  req: NextRequest,
  session: Session | null,
): Promise<boolean> {
  if (!session?.user) return false;
  return canAccessGrants(await resolveUserGroupIds(req, session));
}

export async function canUseGrants(
  req: NextRequest,
  session: Session | null,
): Promise<boolean> {
  if (!(await hasGrantsAccess(req, session))) return false;
  return isWorkflowEnabled('grants');
}
