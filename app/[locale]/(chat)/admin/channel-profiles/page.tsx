import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { ChannelProfilesSection } from '@/components/AgentAccess/ChannelProfiles/ChannelProfilesSection';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Admin-edited channel profiles for the channel drafter. Its OWN gate: the
 * admin layout resolving a rail entry is never sufficient authorization
 * (see lib/services/admin/adminAreas.ts). GLOBAL admins only, matching the
 * route: a channel's limits are organisation-wide data.
 */
export default async function ChannelProfilesAdminPage() {
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
  if (!status.isGlobalAdmin) {
    redirect('/');
  }

  return <ChannelProfilesSection />;
}
