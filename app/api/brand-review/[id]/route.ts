import { NextRequest } from 'next/server';

import {
  REVIEW_ID_PATTERN,
  readBrandReview,
  removeBrandReview,
} from '@/lib/services/brand/brandReviews';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/brand-review/<id>: a review as it stands (findings so far while
 * it runs). A review whose runner has gone quiet is picked up again.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  if (!REVIEW_ID_PATTERN.test(id)) return notFoundResponse('Brand review');
  try {
    const state = await readBrandReview(session, id);
    if (!state) return notFoundResponse('Brand review');
    return successResponse({ reviewId: id, state });
  } catch (error) {
    return handleApiError(error, 'Failed to read the brand review');
  }
}

/** DELETE /api/brand-review/<id>: stops it if it runs, and deletes it. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  if (!REVIEW_ID_PATTERN.test(id)) return notFoundResponse('Brand review');
  try {
    if (!(await removeBrandReview(session, id))) {
      return notFoundResponse('Brand review');
    }
    return successResponse({ removed: id });
  } catch (error) {
    return handleApiError(error, 'Failed to remove the brand review');
  }
}
