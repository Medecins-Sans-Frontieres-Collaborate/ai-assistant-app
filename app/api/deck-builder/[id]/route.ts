import { NextRequest } from 'next/server';

import {
  readDeckJob,
  removeDeckJob,
} from '@/lib/services/deckBuilder/deckBuilds';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/deck-builder/<id>: an outline (`outline-…`) or a build
 * (`deck-…`) as it stands. One whose runner has gone quiet is picked up
 * again.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  try {
    const state = await readDeckJob(session, id);
    if (!state) return notFoundResponse('Deck work');
    return successResponse({ id, state });
  } catch (error) {
    return handleApiError(error, 'Failed to read the deck work');
  }
}

/**
 * DELETE /api/deck-builder/<id>: stops it if it runs, and deletes it. A
 * built deck stays the person's upload.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  try {
    if (!(await removeDeckJob(session, id)))
      return notFoundResponse('Deck work');
    return successResponse({ removed: id });
  } catch (error) {
    return handleApiError(error, 'Failed to remove the deck work');
  }
}
