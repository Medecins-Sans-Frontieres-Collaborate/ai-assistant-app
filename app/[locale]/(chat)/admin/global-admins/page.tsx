import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { GlobalAdminsPanel } from '@/components/Admin/GlobalAdmins/GlobalAdminsPanel';

import { auth } from '@/auth';

/**
 * Config-based global admin roster (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §13):
 * `system/admin/global-admins.json`, edited only by global admins.
 *
 * Gated on the EFFECTIVE identity like every other admin page (and like the
 * /api/admin/global-admins route), so a view-as-demoted admin is bounced and
 * must exit view-as before editing who the global admins are. Not gated on
 * AGENT_ACCESS_CONTROL_ENABLED: the roster is its own configuration and also
 * decides who may author usage limits, so it stays reachable when agent
 * access is off.
 *
 * The caller's mail is passed down so the panel can warn — before Save —
 * when a draft would remove the very person editing it.
 */
export default async function GlobalAdminsPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  if (!isGlobalAdmin(session.user)) {
    redirect('/');
  }

  return <GlobalAdminsPanel currentMail={session.user.mail ?? null} />;
}
