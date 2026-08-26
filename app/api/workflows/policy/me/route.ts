import { WorkflowPolicyService } from '@/lib/services/workflows/policy/WorkflowPolicyService';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/workflows/policy/me — which workflows are currently enabled by
 * the admin policy, for every signed-in user. Drives menu/tab visibility and
 * the "disabled by an administrator" notice; every workflow API route
 * re-checks the policy server-side regardless.
 *
 * Served from the ≤60s cached snapshot (same staleness as enforcement, so
 * what the client hides and what the server refuses agree).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    const service = WorkflowPolicyService.getInstance();
    await service.ensureFresh();
    const { policyUnavailable } = service.getSnapshot();
    return successResponse({
      enabled: service.allEnabled(),
      policyUnavailable,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to resolve workflow policy');
  }
}
