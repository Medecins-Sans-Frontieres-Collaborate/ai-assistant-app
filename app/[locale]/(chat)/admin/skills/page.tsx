import { redirect } from 'next/navigation';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { skillsFeatureEnabled } from '@/lib/services/skills/skillCatalog';

import { SkillsPanel } from '@/components/Admin/Skills/SkillsPanel';

import { auth } from '@/auth';

/**
 * Admin → Skills (docs/SKILLS_DESIGN.md §4).
 *
 * Its OWN gate (the adminAreas.ts contract: the rail resolver is not
 * per-area authorization), the glossaries/guides model: local-or-global
 * admins may open it — created skills are delegated to their creator, and
 * the API re-checks per canonical key on every write. Feature-gated like
 * the API routes: both the agent-access master switch and SKILLS_ENABLED.
 */
export default async function SkillsAdminPage() {
  if (!skillsFeatureEnabled()) redirect('/');
  const session = await auth();
  if (!session) redirect('/signin');

  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const { config } = service.getSnapshot();
  const status = resolveAdminStatus(session.user, config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) redirect('/');

  return <SkillsPanel />;
}
