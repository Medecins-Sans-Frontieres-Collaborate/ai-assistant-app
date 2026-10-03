import { NextRequest } from 'next/server';

import { resolveDeliveryLocation } from '@/lib/services/analytics/deliveryStore';
import { buildHealth } from '@/lib/services/analytics/health';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';

import {
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * GET /api/admin/analytics/health — what is wrong with the deliveries.
 *
 * Every problem is reported, never thrown: an unreachable container, an
 * unreadable file, a column nobody classified and a missing monthly report
 * all come back as data the panel can explain. A delegated admin's view
 * leaves out everything under `raw/`.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    const context = await loadAnalyticsContext(request, session);
    if (!context.actor.isAnalyticsAdmin) return forbiddenResponse();
    return successResponse(
      buildHealth({
        data: context.data,
        files: context.files,
        actor: context.actor,
        deliveryUnavailable: context.deliveryUnavailable,
        foldersUnavailable: context.foldersUnavailable,
        container: resolveDeliveryLocation().containerName,
        deleteEnabled: env.ANALYTICS_RETENTION_DELETE_ENABLED,
        now: context.now,
      }),
    );
  } catch (error) {
    return handleApiError(error, 'Failed to load analytics health');
  }
}
