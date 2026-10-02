import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { ContextBudgetPanel } from '@/components/Admin/ContextBudget/ContextBudgetPanel';

import { auth } from '@/auth';

/**
 * Context budget configuration (lib/services/contextBudget/types.ts).
 *
 * Server component gate: session + GLOBAL admin, evaluated on the session
 * USER so an admin "viewing as" a lesser role is bounced like that role
 * would be. One org-wide document, so no local-admin delegation.
 */
export default async function ContextBudgetAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  if (!isGlobalAdmin(session.user)) {
    redirect('/');
  }

  return <ContextBudgetPanel />;
}
