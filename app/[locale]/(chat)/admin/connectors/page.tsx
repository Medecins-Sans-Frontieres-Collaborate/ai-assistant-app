import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { AgentAccessPanel } from '@/components/AgentAccess/AgentAccessPanel';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Its OWN gate, verbatim from the panel this area came from. The admin layout
 * resolving a rail entry is never sufficient authorization — see
 * lib/services/admin/adminAreas.ts.
 */
export default async function ConnectorsAdminPage() {
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
  const status = resolveAdminStatus(session.user?.mail, config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    redirect('/');
  }

  return <AgentAccessPanel section="connectors" />;
}
