import { NextRequest } from 'next/server';

import { stopDeckJob } from '@/lib/services/deckBuilder/deckBuilds';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

type Params = { params: Promise<{ id: string }> };

/** POST /api/deck-builder/<id>/stop: asks an outline or build to stop. */
export async function POST(_request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  try {
    const state = await stopDeckJob(session, id);
    if (!state) return notFoundResponse('Deck work');
    return successResponse({ id, state });
  } catch (error) {
    return handleApiError(error, 'Failed to stop the deck work');
  }
}
