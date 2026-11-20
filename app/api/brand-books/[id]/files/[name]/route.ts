import { NextRequest, NextResponse } from 'next/server';

import { readBrandBookFile } from '@/lib/services/brand/brandBooks';

import {
  handleApiError,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/brand-books/[id]/files/[name]: a file of a brand book the
 * person may use (THE BRAND FILE CONVENTION in brandBooks.ts). One 404 for
 * no access, no book, a file it does not reference, or a file gone.
 *
 * Files are served as downloads of their own type, never sniffed, and in a
 * sandbox, so an SVG logo cannot run script in the app's origin.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { id, name } = await params;
  try {
    const file = await readBrandBookFile(session, id, name, request);
    if (!file) return notFoundResponse('File');
    return new NextResponse(new Uint8Array(file.data), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.data.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    return handleApiError(error, 'Failed to read brand book file');
  }
}
