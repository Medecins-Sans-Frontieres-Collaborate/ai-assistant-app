/**
 * GET /api/agent-access/m365-agents/manifest?id=<agentId>
 *
 * The per-item record of the agent's last index run (what the planner
 * saw under each source and what the run did with every file). Read by
 * the editor to show per-file outcomes; authorization matches PUT on the
 * agent — an admin holding the agent's canonical key.
 */
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readM365AgentManifest,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  M365_AGENT_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const M365_AGENT_ID_PATTERN = /^m365-[a-f0-9]{12}$/;

export async function GET(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const id = request.nextUrl.searchParams.get('id')?.trim() ?? '';
  if (!M365_AGENT_ID_PATTERN.test(id)) {
    return badRequestResponse('Invalid agent id');
  }
  const canonicalKey = canonicalAgentKey(M365_AGENT_SOURCE, id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this agent key');
    }
    const manifest = await readM365AgentManifest(
      createAgentAccessBlobStorage(),
      id,
    );
    return successResponse({ manifest });
  } catch (error) {
    return handleApiError(error, 'Failed to read M365 agent manifest');
  }
}
