import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import { BrandBooksSection } from '@/components/AgentAccess/BrandBooks/BrandBooksSection';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Admin-curated brand books (docs/DOCUMENT_PLATFORM.md, phase E). Its OWN gate, verbatim from the guides
 * area: the admin layout resolving a rail entry is never sufficient
 * authorization — see lib/services/admin/adminAreas.ts.
 */
export default async function BrandBooksAdminPage() {
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

  return <BrandBooksSection />;
}
