import { NextRequest } from 'next/server';

import { authorizeSkillDocuments } from '@/lib/services/skills/skillDocumentAuth';
import {
  retrySkillIndex,
  stepSkillIndex,
} from '@/lib/services/skills/skillIndexJob';

import {
  handleApiError,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

export const maxDuration = 120;
/** Performs a resumable indexing step, optionally releasing failed items for retry. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorized = await authorizeSkillDocuments(id);
    if (authorized.response) return authorized.response;
    if (request.nextUrl.searchParams.get('retry') === 'true')
      await retrySkillIndex(authorized.storage, id);
    return successResponse(
      await stepSkillIndex(
        authorized.storage,
        id,
        request.signal,
        authorized.userRegion,
      ),
    );
  } catch (error) {
    return handleApiError(error, 'Could not index skill documents');
  }
}
