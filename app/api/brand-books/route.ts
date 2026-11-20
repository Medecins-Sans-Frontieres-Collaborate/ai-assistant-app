import { NextRequest } from 'next/server';

import { usableBrandBooks } from '@/lib/services/brand/brandBooks';
import { DECK_TEMPLATE_TYPES } from '@/lib/services/deckBuilder/deckInputs';

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
          // Deck templates, for the deck builder; their files are reached
          // through the book (the server checks the book lists them).
          templates: record.book.templates
            .filter((template) => DECK_TEMPLATE_TYPES.includes(template.type))
            .map(({ id, name, type, file }) => ({ id, name, type, file })),
          updatedAt: record.updatedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list brand books');
  }
}
