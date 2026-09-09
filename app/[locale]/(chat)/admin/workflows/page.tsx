import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { WorkflowPolicyPanel } from '@/components/Admin/Workflows/WorkflowPolicyPanel';

import { auth } from '@/auth';

/**
 * Workflow enable/disable policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * Server component gate: session + GLOBAL admin, evaluated on the session
 * USER so an admin "viewing as" a lesser role is bounced like that role
 * would be. One org-wide document, so no local-admin delegation.
 */
export default async function WorkflowsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  if (!isGlobalAdmin(session.user)) {
    redirect('/');
  }

  return <WorkflowPolicyPanel />;
}
