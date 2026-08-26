import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/agent-access/me — the caller's admin status for the agent access
 * control UI ({ isGlobalAdmin, isLocalAdmin, editableAgentKeys }). Available
 * to any signed-in user; drives UI visibility only — every admin route
 * re-checks authorization server-side. 404 while the feature is disabled
 * (spec: the whole /api/agent-access surface does not exist without the
 * flag) — checked BEFORE auth so a disabled deployment answers exactly like
 * a route that does not exist (a 401 here would leak the feature's
 * existence to unauthenticated probes).
 */
export async function GET() {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    // Local adminship lives in config.json — served from the cached snapshot
    // (≤60s stale, same as rule evaluation).
    await service.ensureFresh();
    const { config } = service.getSnapshot();
    const status = resolveAdminStatus(session.user, config);
    return successResponse(status);
  } catch (error) {
    return handleApiError(error, 'Failed to resolve admin status');
  }
}
