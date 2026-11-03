import { NextRequest } from 'next/server';

import { hasGrantsAccess } from '@/lib/services/grants/serverAccess';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/grants/access — determines whether the signed-in user is in the grants Entra
 * group (lib/services/grants/access.ts). Drives menu, tab and workspace
 * visibility only; every grants API route re-checks membership server-side.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    return successResponse({
      hasAccess: await hasGrantsAccess(request, session),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to resolve grants access');
  }
}
