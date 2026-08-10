import { resolveAdminAreas } from '@/lib/services/admin/adminAreas';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/admin/areas — which admin areas the caller may open.
 *
 * Drives ONLY the settings nav entry's visibility. It exists because the nav
 * previously derived "is this person a global admin" from
 * `useAgentAccessAdmin()`, whose query is disabled entirely when
 * AGENT_ACCESS_CONTROL_ENABLED is false — so a deployment running limits
 * WITHOUT agent access showed a global admin no admin entry at all. The two
 * env flags are independent kill switches, and this resolves them
 * independently.
 *
 * Available to any signed-in user; a non-admin simply gets an empty list, and
 * every admin page keeps its own server-side gate regardless.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    const { areas, configUnavailable } = await resolveAdminAreas(
      session.user.mail,
    );
    return successResponse({ areas, configUnavailable });
  } catch (error) {
    return handleApiError(error, 'Failed to resolve admin areas');
  }
}
