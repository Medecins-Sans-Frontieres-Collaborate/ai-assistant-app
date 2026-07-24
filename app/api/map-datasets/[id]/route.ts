import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readMapDataset,
} from '@/lib/services/agentAccess/accessRulesStore';
import { MAP_DATASET_SOURCE } from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const MAP_DATASET_ID_PATTERN = /^mapds-[a-f0-9]{12}$/;

/**
 * GET /api/map-datasets/[id] — the full dataset payload for loading into a
 * map workspace (an explicit user action, so the direct ~1MB blob read is
 * paid exactly once per load).
 *
 * Access is evaluated BEFORE the storage read (it needs only the id), and a
 * dataset the user may not see answers the SAME 404 as one that does not
 * exist — anything else is an existence oracle for restricted datasets.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Dataset');

  const { id } = await params;
  if (!MAP_DATASET_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid dataset id');
  }

  try {
    await service.ensureFresh();
    const decision = service.evaluateAccess({
      userMail: session.user.mail ?? undefined,
      source: MAP_DATASET_SOURCE,
      agentName: id,
    });
    // Fail closed on 'unavailable' too — same contract as the listing.
    if (decision.decision !== 'allow') return notFoundResponse('Dataset');

    const existing = await readMapDataset(createAgentAccessBlobStorage(), id);
    if (existing === null) return notFoundResponse('Dataset');

    const { dataset } = existing;
    return successResponse({
      dataset: {
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        features: dataset.features,
        connections: dataset.connections,
        updatedAt: dataset.updatedAt,
      },
    });
  } catch (error) {
    return handleApiError(error, 'Failed to load map dataset');
  }
}
