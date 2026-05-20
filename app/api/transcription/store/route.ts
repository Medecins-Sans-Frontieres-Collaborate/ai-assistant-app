/**
 * Transcript Storage Endpoint
 *
 * Stores a transcript in Azure Blob Storage for later retrieval.
 * Used for large transcripts (>10KB) that shouldn't be stored inline in messages.
 *
 * POST /api/transcription/store
 * Body: { jobId: string, transcript: string, filename: string }
 * Returns: { blobPath: string, expiresAt: string }
 */
import { NextRequest } from 'next/server';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import {
  TRANSCRIPT_EXPIRY_DAYS,
  TranscriptReference,
} from '@/types/transcription';

import { auth } from '@/auth';
import { env } from '@/config/environment';

interface StoreRequest {
  jobId: string;
  transcript: string;
  filename: string;
}

export async function POST(request: NextRequest) {
  // Verify authentication
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let body: StoreRequest;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body', 'INVALID_JSON');
  }

  const { jobId, transcript, filename } = body;

  if (!jobId || !transcript || !filename) {
    return badRequestResponse(
      'jobId, transcript, and filename are required',
      'MISSING_PARAMS',
    );
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

    // Store transcript in user's transcript folder
    const blobPath = `${session.user.id}/transcripts/${jobId}.txt`;

    // Upload transcript content
    await blobStorage.upload(blobPath, transcript, {
      blobHTTPHeaders: {
        blobContentType: 'text/plain; charset=utf-8',
      },
    });

    // Calculate expiration date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TRANSCRIPT_EXPIRY_DAYS);

    console.log(
      `[TranscriptStore] Stored transcript for job ${jobId}: ${blobPath} (${transcript.length} bytes)`,
    );

    const response: TranscriptReference = {
      filename,
      jobId,
      blobPath,
      expiresAt: expiresAt.toISOString(),
    };

    return successResponse(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `[TranscriptStore] Failed to store transcript:`,
      errorMessage,
    );
    return errorResponse(`Failed to store transcript: ${errorMessage}`);
  }
}
