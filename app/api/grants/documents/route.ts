import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';

import { auth } from '@/auth';

/**
 * POST /api/grants/documents
 *
 * Upload a narrative document to blob storage for a given OC.
 *
 * Request: multipart/form-data with:
 *   - file: File (the document to upload)
 *   - oc: string (OCA, OCB, etc.)
 *
 * Response: { success: true, blobPath, filename }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const oc = formData.get('oc') as string | null;

    if (!file) {
      return NextResponse.json(
        { error: 'Missing required field: file' },
        { status: 400 },
      );
    }

    if (!oc) {
      return NextResponse.json(
        { error: 'Missing required field: oc' },
        { status: 400 },
      );
    }

    const storage = createBlobStorageClient(session);
    const buffer = Buffer.from(await file.arrayBuffer());
    const blobPath = `grants/${oc}/narratives/${file.name}`;

    await storage.upload(blobPath, buffer, {
      blobHTTPHeaders: {
        blobContentType: file.type,
      },
    });

    return NextResponse.json({
      success: true,
      blobPath,
      filename: file.name,
    });
  } catch (error) {
    console.error('[Grants Documents] Upload error:', error);
    return NextResponse.json(
      {
        error: 'Failed to upload document',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/grants/documents
 *
 * List documents for a given OC.
 *
 * Query params:
 *   - oc: string (required) - the OC identifier (e.g. OCA, OCB)
 *   - type: string (optional, default "narrative") - document type
 *
 * Response: { documents: [{ name, size, lastModified, blobPath }] }
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

    const { searchParams } = new URL(request.url);
    const oc = searchParams.get('oc');
    const type = searchParams.get('type') || 'narrative';

    if (!oc) {
      return NextResponse.json(
        { error: 'Missing required query parameter: oc' },
        { status: 400 },
      );
    }

    const storage = createBlobStorageClient(session);
    const prefix = `grants/${oc}/${type}s/`;
    const blobs = await storage.listBlobs(prefix);

    const documents = blobs.map((blob) => ({
      name: blob.name.split('/').pop() || blob.name,
      size: blob.size,
      lastModified: blob.lastModified,
      blobPath: blob.name,
    }));

    return NextResponse.json({ documents });
  } catch (error) {
    console.error('[Grants Documents] List error:', error);
    return NextResponse.json(
      {
        error: 'Failed to list documents',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/grants/documents
 *
 * Remove a document from blob storage.
 *
 * Query params:
 *   - blobPath: string (required) - full blob path to delete
 *
 * Response: { success: true }
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const blobPath = searchParams.get('blobPath');

    if (!blobPath) {
      return NextResponse.json(
        { error: 'Missing required query parameter: blobPath' },
        { status: 400 },
      );
    }

    const storage = createBlobStorageClient(session);

    if (blobPath === 'all') {
      const oc = searchParams.get('oc');
      if (!oc) {
        return NextResponse.json(
          {
            error:
              'Missing required query parameter: oc (needed for bulk delete)',
          },
          { status: 400 },
        );
      }

      const blobs = await storage.listBlobs(`grants/${oc}/narratives/`);
      let deleted = 0;
      for (const blob of blobs) {
        await storage.deleteIfExists(blob.name);
        deleted++;
      }

      return NextResponse.json({ success: true, deleted });
    }

    if (!blobPath.startsWith('grants/')) {
      return NextResponse.json(
        { error: 'Invalid blob path: must start with "grants/"' },
        { status: 400 },
      );
    }

    await storage.deleteIfExists(blobPath);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Grants Documents] Delete error:', error);
    return NextResponse.json(
      {
        error: 'Failed to delete document',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
