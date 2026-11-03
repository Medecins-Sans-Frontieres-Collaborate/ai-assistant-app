/** Shared authorization for resource administration; mirrors the skill CRUD gate. */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readSkill,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  SKILL_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import {
  forbiddenResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { BUILTIN_SKILL_IDS } from './builtinSkills';
import { orgSkillsAvailable } from './skillCatalog';
import { SkillIdSchema } from './types';

import { auth } from '@/auth';

/** Resolves a stored skill for an authorized admin, or an HTTP error response. */
export async function authorizeSkillDocuments(id: string) {
  if (!orgSkillsAvailable() || !SkillIdSchema.safeParse(id).success)
    return { response: notFoundResponse('Skill') };
  const session = await auth();
  if (!session?.user) return { response: unauthorizedResponse() };
  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  const userMail = session.user.mail?.trim().toLowerCase();
  if (
    !userMail ||
    (!status.isGlobalAdmin && !status.isLocalAdmin) ||
    !canEditKey(status, canonicalAgentKey(SKILL_SOURCE, id)) ||
    (BUILTIN_SKILL_IDS.has(id) && !status.isGlobalAdmin)
  )
    return { response: forbiddenResponse() };
  const storage = createAgentAccessBlobStorage();
  const stored = await readSkill(storage, id);
  if (!stored)
    return {
      response: notFoundResponse('Stored skill (save a customization first)'),
    };
  return { storage, ...stored, userMail, userRegion: session.user.region };
}
