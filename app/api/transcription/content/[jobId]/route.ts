/**
 * Transcript Content Fetch Endpoint
 *
 * Retrieves a transcript from Azure Blob Storage.
 * Used by the UI to load large transcripts on demand.
 *
 * GET /api/transcription/content/[jobId]
 * Returns: { transcript: string } or 404 if not found/expired
 */
import { NextRequest } from 'next/server';

import { JOB_ID_REGEX } from '@/lib/services/transcription/chunkedJobStore';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage, BlobProperty } from '@/lib/utils/server/blob/blob';

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

  if (!jobId) {
    return notFoundResponse('Job ID is required');
  }

  // Route params arrive URL-decoded, so without this check a crafted jobId
  // (e.g. containing `../`) would be interpolated straight into the blob
  // path below. Same validation as the store/cleanup/status routes.
  if (!JOB_ID_REGEX.test(jobId)) {
    return badRequestResponse('Invalid jobId format', 'INVALID_JOB_ID');
  }

  try {
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

    // Transcripts are stored in user's transcript folder
    const blobPath = `${session.user.id}/transcripts/${jobId}.txt`;

    // Check if blob exists
    const exists = await blobStorage.blobExists(blobPath);
    if (!exists) {
      console.log(
        `[TranscriptContent] Transcript not found or expired: ${blobPath}`,
      );
      return notFoundResponse(
        'Transcript not found. It may have expired or been deleted.',
      );
    }

    // Get transcript content
    const content = await blobStorage.get(blobPath, BlobProperty.BLOB);
    const transcript =
      content instanceof Buffer ? content.toString('utf-8') : String(content);

    console.log(
      `[TranscriptContent] Retrieved transcript for job ${jobId} (${transcript.length} bytes)`,
    );

    return successResponse({
      transcript,
      jobId,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `[TranscriptContent] Failed to retrieve transcript:`,
      errorMessage,
    );

    // Return 404 for blob not found errors
    if (errorMessage.includes('BlobNotFound') || errorMessage.includes('404')) {
      return notFoundResponse(
        'Transcript not found. It may have expired or been deleted.',
      );
    }

    return errorResponse(`Failed to retrieve transcript: ${errorMessage}`);
  }
}
