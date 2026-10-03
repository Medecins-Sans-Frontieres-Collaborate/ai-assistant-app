import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import {
  hasAnyAnalyticsAccess,
  indexFolders,
} from '@/lib/services/analytics/access';
import { resolveAnalyticsActor } from '@/lib/services/analytics/actor';
import { AnalyticsAccessResponse } from '@/lib/services/analytics/dto';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/analytics/access — whether the caller has anything to open under
 * /analytics. Drives ONLY the visibility of the navigation entry; it reads
 * the folder overlay and never lists the delivery container, so it is cheap
 * enough to call for every signed-in user.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    const service = AnalyticsService.getInstance();
    const [{ actor }] = await Promise.all([
      resolveAnalyticsActor(request, session),
      service.ensureFoldersFresh(),
    ]);
    const body: AnalyticsAccessResponse = {
      hasAccess: hasAnyAnalyticsAccess(
        indexFolders(service.getSnapshot().folders?.folders),
        actor,
      ),
      canAdmin: actor.isAnalyticsAdmin,
    };
    return successResponse(body);
  } catch (error) {
    return handleApiError(error, 'Failed to resolve analytics access');
  }
}
