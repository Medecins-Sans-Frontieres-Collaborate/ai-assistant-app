import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { AgentAccessPanel } from '@/components/AgentAccess/AgentAccessPanel';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/** Dataset LIST. The per-dataset editor at ./[id] keeps its own extra check. */
export default async function MapDatasetsAdminPage() {
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

  return <AgentAccessPanel section="datasets" />;
}
