/**
 * GET /api/agent-access/m365-agents/index/status?id=<agentId>
 *
 * The agent's current job summary (null when it was never indexed under
 * the job pipeline). Used after a reload to offer Resume on an
 * interrupted job.
 */
import { NextRequest } from 'next/server';

import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import { getIndexJobSummary } from '@/lib/services/m365/agentIndexJobService';

import {
  handleApiError,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim() ?? '';
  try {
    const authz = await authorizeM365AgentAdmin(id);
    if (!authz.ok) return authz.response;
    const job = await getIndexJobSummary(createAgentAccessBlobStorage(), id);
    return successResponse({ job });
  } catch (error) {
    return handleApiError(error, 'Failed to read indexing status');
  }
}
