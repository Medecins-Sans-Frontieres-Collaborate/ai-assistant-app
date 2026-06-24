import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';

import { auth } from '@/auth';

/**
 * GET /api/grants/documents/serve?blobPath=grants/OCA/narratives/file.pdf
 *
 * Generates a time-limited SAS URL for the requested blob and redirects
 * the browser to it.  This lets users view narrative documents directly
 * without proxying the entire file through the Node server.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const blobPath = request.nextUrl.searchParams.get('blobPath');

    if (!blobPath) {
      return NextResponse.json(
        { error: 'Missing required query parameter: blobPath' },
        { status: 400 },
      );
    }

    // Validate path to prevent traversal — must be under grants/
    if (!blobPath.startsWith('grants/')) {
      return NextResponse.json({ error: 'Invalid blob path' }, { status: 400 });
    }

    const storage = createBlobStorageClient(session);
    const sasUrl = await storage.generateSasUrl(blobPath, 1); // 1-hour expiry

    return NextResponse.redirect(sasUrl);
  } catch (error) {
    console.error('Error serving grant document:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
