import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';

import { auth } from '@/auth';

/**
 * POST /api/grants/supplemental
 *
 * Upload a supplemental file for a given OC or as a shared resource.
 *
 * Request: multipart/form-data with:
 *   - file: File (the supplemental file to upload)
 *   - oc: string (OC identifier, or "shared" for shared supplemental files)
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

    const blobPath =
      oc === 'shared'
        ? `grants/shared/supplemental/${file.name}`
        : `grants/${oc}/supplemental/${file.name}`;

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
    console.error('[Grants Supplemental] Upload error:', error);
    return NextResponse.json(
      {
        error: 'Failed to upload supplemental file',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/grants/supplemental
 *
 * List supplemental files for a given OC, including shared files.
 *
 * Query params:
 *   - oc: string (required) - the OC identifier (e.g. OCA, OCB)
 *
 * Response: { files: [{ name, size, lastModified, blobPath, scope }] }
 *   - scope is "oc" for OC-specific files or "shared" for shared files
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

    if (!oc) {
      return NextResponse.json(
        { error: 'Missing required query parameter: oc' },
        { status: 400 },
      );
    }

    const storage = createBlobStorageClient(session);

    // Fetch OC-specific and shared supplemental files in parallel
    const [ocBlobs, sharedBlobs] = await Promise.all([
      storage.listBlobs(`grants/${oc}/supplemental/`),
      storage.listBlobs('grants/shared/supplemental/'),
    ]);

    const ocFiles = ocBlobs.map((blob) => ({
      name: blob.name.split('/').pop() || blob.name,
      size: blob.size,
      lastModified: blob.lastModified,
      blobPath: blob.name,
      scope: 'oc' as const,
    }));

    const sharedFiles = sharedBlobs.map((blob) => ({
      name: blob.name.split('/').pop() || blob.name,
      size: blob.size,
      lastModified: blob.lastModified,
      blobPath: blob.name,
      scope: 'shared' as const,
    }));

    return NextResponse.json({ files: [...ocFiles, ...sharedFiles] });
  } catch (error) {
    console.error('[Grants Supplemental] List error:', error);
    return NextResponse.json(
      {
        error: 'Failed to list supplemental files',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/grants/supplemental
 *
 * Remove supplemental file(s) from blob storage.
 *
 * Query params:
 *   - blobPath: string (required) - full blob path, or "all" to remove all
 *   - oc: string (required when blobPath=all) - OC identifier
 *
 * Response: { success: true, deleted: number }
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
    const oc = searchParams.get('oc');

    if (!blobPath) {
      return NextResponse.json(
        { error: 'Missing required query parameter: blobPath' },
        { status: 400 },
      );
    }

    const storage = createBlobStorageClient(session);

    if (blobPath === 'all') {
      if (!oc) {
        return NextResponse.json(
          {
            error:
              'Missing required query parameter: oc (needed for bulk delete)',
          },
          { status: 400 },
        );
      }

      const blobs = await storage.listBlobs(`grants/${oc}/supplemental/`);
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
    return NextResponse.json({ success: true, deleted: 1 });
  } catch (error) {
    console.error('[Grants Supplemental] Delete error:', error);
    return NextResponse.json(
      {
        error: 'Failed to delete supplemental file',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
