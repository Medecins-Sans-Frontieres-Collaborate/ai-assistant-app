import type { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { verifyDocToken } from '@/lib/services/grants/docToken';

import { getEnvVariable } from '@/lib/utils/app/env';
import { AzureBlobStorage, BlobProperty } from '@/lib/utils/server/blob/blob';

import { env } from '@/config/environment';

/**
 * GET /api/grants/documents/viewer-fetch?token=...
 *
 * Token-authenticated (sessionless) fetch endpoint for the Office Online
 * viewer: verifies the HMAC token created by the serve route and streams the
 * blob server-side. Storage resolves to the US region as grants is
 * MSF-USA-only.
 */

const DOCUMENT_TYPES: Record<string, string> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const blobPath = verifyDocToken(token);
    if (!blobPath) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 403 },
      );
    }

    // Defense in depth: re-apply the serve route's path constraints.
    if (!blobPath.startsWith('grants/') || blobPath.includes('..')) {
      return NextResponse.json({ error: 'Invalid blob path' }, { status: 400 });
    }

    const usUser = { region: 'US' } as Session['user'];
    const storage = new AzureBlobStorage(
      getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user: usUser }),
      getEnvVariable({
        name: 'AZURE_BLOB_STORAGE_CONTAINER',
        throwErrorOnFail: false,
        defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
        user: usUser,
      }),
      usUser,
    );
    const data = (await storage.get(blobPath, BlobProperty.BLOB)) as Buffer;

    const filename = blobPath.split('/').pop() || 'document';
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': DOCUMENT_TYPES[ext] || 'application/octet-stream',
        'Content-Length': String(data.length),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('Error serving viewer fetch:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
