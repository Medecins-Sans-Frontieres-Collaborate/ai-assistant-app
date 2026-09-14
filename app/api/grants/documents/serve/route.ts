import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { mintDocToken } from '@/lib/services/grants/docToken';
import { canUseGrants } from '@/lib/services/grants/serverAccess';

import { BlobProperty } from '@/lib/utils/server/blob/blob';

import { auth } from '@/auth';

/**
 * GET /api/grants/documents/serve?blobPath=grants/OCA/narratives/file.pdf
 *
 * Serves grant documents server-side (the storage account's network rules
 * block direct browser/viewer access). PDF and text stream inline; Office
 * documents open in the Microsoft Online viewer via a token URL on this
 * app's domain.
 */

const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
};

// Browser-renderable types are served inline.
const INLINE_EXTS = new Set(['pdf', 'txt']);

// Types the Microsoft Office Online viewer can render.
const OFFICE_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

function publicOrigin(request: NextRequest): string | null {
  const host = request.headers.get('x-forwarded-host') ?? request.nextUrl.host;
  if (!host || /localhost|127\.0\.0\.1/.test(host)) return null;
  const proto =
    request.headers.get('x-forwarded-proto') ??
    request.nextUrl.protocol.replace(':', '');
  if (proto !== 'https') return null;
  return `https://${host}`;
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!(await canUseGrants(session.user))) {
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
    if (!blobPath.startsWith('grants/') || blobPath.includes('..')) {
      return NextResponse.json({ error: 'Invalid blob path' }, { status: 400 });
    }

    const filename = blobPath.split('/').pop() || 'document';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    // Office documents: open in the Office Online viewer via viewer-fetch.
    if (OFFICE_EXTS.has(ext)) {
      const origin = publicOrigin(request);
      if (origin) {
        const token = mintDocToken(blobPath);
        const fetchUrl = `${origin}/api/grants/documents/viewer-fetch?token=${encodeURIComponent(token)}`;
        const viewerUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(fetchUrl)}`;
        return NextResponse.redirect(viewerUrl);
      }
      // Local dev has no public origin: fall through to a download.
    }

    const storage = createBlobStorageClient(session);
    const data = (await storage.get(blobPath, BlobProperty.BLOB)) as Buffer;

    const contentType = DOCUMENT_TYPES[ext] || 'application/octet-stream';
    const disposition = INLINE_EXTS.has(ext) ? 'inline' : 'attachment';

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        // filename* (RFC 5987) handles non-ASCII filenames.
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
      },
    });
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
