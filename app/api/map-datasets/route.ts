import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  listAllMapDatasetMetas,
} from '@/lib/services/agentAccess/accessRulesStore';
import { MAP_DATASET_SOURCE } from '@/lib/services/agentAccess/types';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/map-datasets — the admin-curated map datasets THIS user may load.
 *
 * The end-user counterpart to /api/agent-access/map-datasets (admin CRUD).
 * Serves META records only — the picker lists by name/counts, and the full
 * payload comes from /api/map-datasets/[id] when the user actually loads.
 * Unlike the other entities, datasets never enter the AgentAccessService
 * snapshot (payload size), so the meta listing is a direct storage read;
 * access rules still evaluate from the snapshot.
 *
 * Returns an empty list rather than a 403 when the feature is off or the
 * user is entitled to nothing: "no datasets" is a normal state.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    return successResponse({ datasets: [] });
  }

  // Group-membership warm-up MUST precede the evaluateAccess filter below —
  // group-scoped rules read the cache synchronously. Never throws.
  await resolveUserGroupIds(request, session);

  try {
    await service.ensureFresh();
    const userMail = session.user.mail ?? undefined;

    const metas = await listAllMapDatasetMetas(createAgentAccessBlobStorage());
    const datasets = metas
      .filter(
        (entry) =>
          // Fail closed on 'unavailable' too: listing a dataset the load
          // endpoint would then refuse is worse than omitting it, and the
          // two paths must agree.
          service.evaluateAccess({
            userMail,
            source: MAP_DATASET_SOURCE,
            agentName: entry.meta.id,
          }).decision === 'allow',
      )
      .map((entry) => ({
        id: entry.meta.id,
        name: entry.meta.name,
        description: entry.meta.description,
        tags: entry.meta.tags,
        featureCount: entry.meta.featureCount,
        connectionCount: entry.meta.connectionCount,
        updatedAt: entry.meta.updatedAt,
      }));

    return successResponse({ datasets });
  } catch (error) {
    return handleApiError(error, 'Failed to list map datasets');
  }
}
