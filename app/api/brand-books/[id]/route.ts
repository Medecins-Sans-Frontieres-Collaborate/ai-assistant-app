import { NextRequest } from 'next/server';

import { usableBrandBook } from '@/lib/services/brand/brandBooks';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/brand-books/[id]: one brand book the person may use, whole.
 * 404 alike for a book that does not exist and one they may not use.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id } = await params;
  try {
    const record = await usableBrandBook(session, id, request);
    if (!record) return notFoundResponse('Brand book');
    return successResponse({
      id: record.id,
      book: record.book,
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to read brand book');
  }
}
