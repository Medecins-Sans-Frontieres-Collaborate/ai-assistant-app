import { NextRequest } from 'next/server';

import { usableBrandBooks } from '@/lib/services/brand/brandBooks';

import {
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/brand-books: the brand books this person may use (their access
 * rules, `brand-book::<id>`), as a summary for a picker. An empty list,
 * not 403, when agent access is off or nothing is shared: "no brand books"
 * is a normal state.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  try {
    const books = await usableBrandBooks(session, request);
    return successResponse({
      books: books
        .map((record) => ({
          id: record.id,
          name: record.book.name,
          description: record.book.description,
          colors: record.book.palette.slice(0, 8).map((color) => color.hex),
          updatedAt: record.updatedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list brand books');
  }
}
