import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { GUIDE_SOURCE } from '@/lib/services/agentAccess/types';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/guides — the admin-authored workflow guides THIS user may use.
 *
 * The end-user counterpart to /api/agent-access/guides (which is admin CRUD).
 * Metadata only — no body: the picker lists guides by name/kind, and the body
 * is fetched on demand from /api/guides/[id] for the read-only view. Keeping
 * it out of the listing keeps the payload small when many long guides exist.
 *
 * Returns an empty list rather than a 403 when the feature is off or the user
 * is entitled to nothing: "no guides" is a normal state, not an error.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    return successResponse({ guides: [] });
  }

  try {
    await service.ensureFresh();
    const userMail = session.user.mail ?? undefined;

    const guides = service
      .getGuides()
      .filter(
        (guide) =>
          // Fail closed on 'unavailable' too: listing a guide that assess
          // would then refuse to resolve is a worse experience than omitting
          // it, and the two paths must agree.
          service.evaluateAccess({
            userMail,
            source: GUIDE_SOURCE,
            agentName: guide.id,
          }).decision === 'allow',
      )
      .map((guide) => ({
        id: guide.id,
        kind: guide.kind,
        name: guide.name,
        description: guide.description,
        languages: guide.languages,
        workflows: guide.workflows,
        updatedAt: guide.updatedAt,
      }));

    return successResponse({ guides });
  } catch (error) {
    return handleApiError(error, 'Failed to list guides');
  }
}
