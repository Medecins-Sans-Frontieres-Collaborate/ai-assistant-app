import { NextRequest } from 'next/server';

import {
  REVIEW_ID_PATTERN,
  stopBrandReview,
} from '@/lib/services/brand/brandReviews';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/** POST /api/brand-review/<id>/stop: stops a running review; it keeps what it found. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  if (!REVIEW_ID_PATTERN.test(id)) return notFoundResponse('Brand review');
  try {
    const state = await stopBrandReview(session, id);
    if (!state) return notFoundResponse('Brand review');
    return successResponse({ reviewId: id, state });
  } catch (error) {
    return handleApiError(error, 'Failed to stop the brand review');
  }
}
