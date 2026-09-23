import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { DelegationsPanel } from '@/components/Admin/Delegations/DelegationsPanel';

import { auth } from '@/auth';

/**
 * Shared delegations (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §7).
 *
 * Server component gate: session + GLOBAL admin, evaluated on the session
 * USER so an admin "viewing as" a lesser role is bounced like that role would
 * be. A delegation decides who else may administer, so a delegate never edits
 * one.
 */
export default async function DelegationsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }
  if (!isGlobalAdmin(session.user)) {
    redirect('/');
  }
  return <DelegationsPanel />;
}
