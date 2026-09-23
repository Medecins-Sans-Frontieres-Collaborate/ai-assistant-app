import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { ChannelSetsSection } from '@/components/AgentAccess/ChannelSets/ChannelSetsSection';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Admin-edited channel rule sets for the channel drafter. Its OWN gate: the
 * admin layout resolving a rail entry is never sufficient authorization
 * (see lib/services/admin/adminAreas.ts). ANY admin, matching the route: a
 * local admin sees the list and edits the sets delegated to them.
 */
export default async function ChannelSetsAdminPage() {
  if (!env.AGENT_ACCESS_CONTROL_ENABLED) {
    redirect('/');
  }

  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const { config } = service.getSnapshot();
  const status = resolveAdminStatus(session.user, config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    redirect('/');
  }

  return <ChannelSetsSection />;
}
