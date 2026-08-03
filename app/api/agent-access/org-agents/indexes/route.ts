import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { listSearchIndexNames } from '@/lib/services/orgAgents/orgAgentSearchValidation';

import {
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/agent-access/org-agents/indexes — index names on the org search
 * endpoint, for the admin editor's picker. Indexes are PICKED, never typed:
 * with this list a nonexistent index name cannot even be submitted, which is
 * the first of the org-agent data guarantees (the save-time validation in
 * the CRUD route is the second, the registry's serve gate the third).
 * 404 while agent access control is disabled; admin-gated like the CRUD.
 */
export async function GET() {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user.mail,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const indexes = await listSearchIndexNames();
    return successResponse({ indexes });
  } catch (error) {
    return handleApiError(error, 'Failed to list search indexes');
  }
}
