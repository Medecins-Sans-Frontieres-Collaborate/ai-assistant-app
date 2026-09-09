import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';

import { ViewAsPanel } from '@/components/Admin/ViewAs/ViewAsPanel';

import { auth } from '@/auth';

/**
 * "View as" — admin test mode (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * ⚠ Gated on the REAL identity (bare-mail form of isGlobalAdmin), unlike
 * every other admin page: an admin currently viewing as a regular user has
 * no other admin area left, and this page is how they adjust or exit.
 */
export default async function ViewAsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  if (!isGlobalAdmin(session.user?.mail)) {
    redirect('/');
  }

  const offices = OfficeResolver.getAllOffices().map((office) => ({
    id: office.id,
    displayName: office.displayName,
    region: office.region,
  }));

  return <ViewAsPanel offices={offices} />;
}
