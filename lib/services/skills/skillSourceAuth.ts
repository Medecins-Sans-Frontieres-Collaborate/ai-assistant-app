/**
 * Gate for skill-source administration (docs/SKILLS_DESIGN.md §12): global
 * admins only. A source writes organization-wide guidance on a schedule,
 * which is a global-admin power regardless of which keys a local admin may
 * edit.
 */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import {
  forbiddenResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { orgSkillsAvailable } from './skillCatalog';

import { auth } from '@/auth';

export async function requireSkillSourceAdmin(): Promise<
  { userMail: string } | Response
> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled() || !orgSkillsAvailable())
    return notFoundResponse('Resource');
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin) return forbiddenResponse();
  return { userMail };
}
