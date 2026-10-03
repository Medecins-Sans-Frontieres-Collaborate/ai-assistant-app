import { NextRequest } from 'next/server';

import { AnalyticsTreeResponse } from '@/lib/services/analytics/dto';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import { buildFolderViews } from '@/lib/services/analytics/viewModel';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/analytics/tree — the folders the caller may see.
 *
 * A folder nobody granted them is absent, not marked "locked": the tree is
 * built from what they can open, plus the bare path of each ancestor so the
 * hierarchy still reads. A person with no access gets an empty tree.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    const context = await loadAnalyticsContext(request, session);
    const body: AnalyticsTreeResponse = {
      folders: buildFolderViews(context.data, context.files, context.actor),
      canAdmin: context.actor.isAnalyticsAdmin,
      groupsDegraded: context.groupsDegraded,
      deliveryUnavailable: context.deliveryUnavailable,
    };
    return successResponse(body);
  } catch (error) {
    return handleApiError(error, 'Failed to load analytics folders');
  }
}
