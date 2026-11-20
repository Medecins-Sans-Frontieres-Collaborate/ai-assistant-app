/**
 * How a route answers when a deck cannot be made ready or finished.
 */
import { NextResponse } from 'next/server';

import { renderErrorResponse } from '@/lib/services/presentationRender/renderErrorResponse';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';

import { isDeckReadError } from './deckText';

/**
 * The response for a deck error; null for any other error.
 *
 * - The render service's errors (busy, protected or unreadable file, time
 *   and memory limits): as renderErrorResponse answers them.
 * - A file that is not a readable deck: 422 `DECK_UNREADABLE`.
 */
export function deckErrorResponse(error: unknown): NextResponse | null {
  const rendered = renderErrorResponse(error);
  if (rendered) return rendered;
  if (isDeckReadError(error)) {
    return errorResponse(
      `This presentation cannot be read: ${(error as Error).message}`,
      422,
      undefined,
      'DECK_UNREADABLE',
    );
  }
  return null;
}
