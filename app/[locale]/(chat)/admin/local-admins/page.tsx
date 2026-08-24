import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { AgentAccessPanel } from '@/components/AgentAccess/AgentAccessPanel';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * The delegation map decides who else may edit access rules, so it is
 * GLOBAL-ADMIN ONLY — a stricter gate than the other agent-access areas.
 *
 * This is the first SERVER-side gate this surface has ever had: as a tab it
 * was hidden only by a client-side filter in AgentAccessPanel, which is a UI
 * convenience and not a control. Promoting it to a route made the gap
 * addressable, so it is closed here.
 */
export default async function LocalAdminsPage() {
  if (!env.AGENT_ACCESS_CONTROL_ENABLED) {
    redirect('/');
  }

  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  if (!isGlobalAdmin(session.user)) {
    redirect('/');
  }

  return <AgentAccessPanel section="localAdmins" />;
}
