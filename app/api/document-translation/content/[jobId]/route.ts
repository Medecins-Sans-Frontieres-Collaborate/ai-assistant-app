/**
 * Document Translation Content Retrieval Endpoint
 *
 * Downloads a translated document from blob storage.
 *
 * GET /api/document-translation/content/[jobId]
 * Query params:
 *   - filename: string (optional) - Filename for the download
 *   - ext: string (optional) - File extension (default: 'txt')
 *
 * Returns: Binary file with appropriate Content-Type and Content-Disposition headers
 */
import { NextRequest, NextResponse } from 'next/server';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  errorResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage, BlobProperty } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  isSafeBlobPathId,
  sanitizeBlobExtension,
} from '@/lib/utils/shared/blobPath';

import { getDocumentContentType } from '@/types/documentTranslation';

import { auth } from '@/auth';
import { env } from '@/config/environment';

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  // Verify authentication
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const { jobId } = await params;

  // Validate jobId format (should be UUID). Both a path segment AND the SAS
  // container structure depend on this being traversal-free.
  if (!isSafeBlobPathId(jobId)) {
    return notFoundResponse('Translated document', 'Invalid job ID format.');
  }

  // Get query parameters
  const searchParams = request.nextUrl.searchParams;
  const filename = searchParams.get('filename') || 'translated_document';
  // `ext` is fully attacker-controlled query input interpolated into the blob
  // path — sanitize to a bare alphanumeric extension so it can't traverse
  // (`../`, `%2e`, separators, a smuggled query string) or escape the slot.
  const ext = sanitizeBlobExtension(searchParams.get('ext'), 'txt');
  const isOriginal = searchParams.get('original') === 'true';

  try {
    // Initialize blob storage
    const blobStorage = new AzureBlobStorage(
      getEnvVariable({
        name: 'AZURE_BLOB_STORAGE_NAME',
        user: session.user,
      }),
      getEnvVariable({
        name: 'AZURE_BLOB_STORAGE_CONTAINER',
        throwErrorOnFail: false,
        defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
        user: session.user,
      }),
      session.user,
    );

    // Build blob path (original or translated)
    const blobPath = isOriginal
      ? `${session.user.id}/translations/${jobId}_original.${ext}`
      : `${session.user.id}/translations/${jobId}.${ext}`;

    // Check if blob exists
    const exists = await blobStorage.blobExists(blobPath);
    if (!exists) {
      return notFoundResponse(
        'Translated document',
        'The translated document was not found or has expired.',
      );
    }

    // Get the blob content
    const content = (await blobStorage.get(
      blobPath,
      BlobProperty.BLOB,
    )) as Buffer;

    // Determine content type from filename
    const contentType = getDocumentContentType(filename);

    console.log(
      `[DocumentTranslation] Downloaded ${isOriginal ? 'original' : 'translated'} file for job ${jobId}: ${sanitizeForLog(blobPath)} (${content.length} bytes)`,
    );

    // Return the file as a binary response (convert Buffer to Uint8Array for NextResponse compatibility)
    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': content.length.toString(),
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    console.error(
      `[DocumentTranslation] Failed to retrieve translation:`,
      errorMessage,
    );

    return errorResponse(
      `Failed to retrieve translated document: ${errorMessage}`,
      500,
      undefined,
      'RETRIEVAL_FAILED',
    );
  }
}
