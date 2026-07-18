import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { AgentAccessPanel } from '@/components/AgentAccess/AgentAccessPanel';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Agent access admin page (docs/AGENT_ACCESS_CONTROL.md "Admin UI").
 *
 * Server component gate: feature flag + session + admin check, redirecting
 * everyone else. The sidebar link never being shown is NOT the security
 * control — this page (and the /api/agent-access routes it drives) are.
 */
export default async function AgentAccessAdminPage() {
  if (!env.AGENT_ACCESS_CONTROL_ENABLED) {
    redirect('/');
  }

  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  // Local-admin status lives in config.json, served from the same cached
  // snapshot the enforcement points use.
  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const { config } = service.getSnapshot();
  const status = resolveAdminStatus(session.user?.mail, config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    redirect('/');
  }

  return <AgentAccessPanel />;
}
