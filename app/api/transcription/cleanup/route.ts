/**
 * Transcription Cleanup Endpoint
 *
 * Cleans up Azure resources after batch transcription completes or times out.
 * Deletes both the transcription job and the temporary audio blob.
 *
 * POST /api/transcription/cleanup
 * Body: { jobId: string, blobPath: string }
 */
import { NextRequest } from 'next/server';

import { BatchTranscriptionService } from '@/lib/services/transcription/batchTranscriptionService';
import {
  JOB_ID_REGEX,
  getJobForUser,
} from '@/lib/services/transcription/chunkedJobStore';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { cleanupChunks } from '@/lib/utils/server/audio/audioSplitter';
import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { env } from '@/config/environment';

interface CleanupRequest {
  jobId?: string;
  blobPath?: string;
}

/**
 * Ensures the blob path is shaped like `${userId}/transcripts/${uuid}.txt`
 * and the prefix matches the authenticated user. Blocks arbitrary-delete
 * attacks via crafted paths (including other users' blobs).
 */
function isValidTranscriptBlobPath(blobPath: string, userId: string): boolean {
  const prefix = `${userId}/transcripts/`;
  if (!blobPath.startsWith(prefix)) {
    return false;
  }
  const filename = blobPath.slice(prefix.length);
  if (!filename.endsWith('.txt')) {
    return false;
  }
  const basename = filename.slice(0, -'.txt'.length);
  return JOB_ID_REGEX.test(basename);
}

export async function POST(request: NextRequest) {
  // Verify authentication
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let body: CleanupRequest;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body', 'INVALID_JSON');
  }

  const { jobId, blobPath } = body;

  if (!jobId && !blobPath) {
    return badRequestResponse(
      'At least one of jobId or blobPath is required',
      'MISSING_PARAMS',
    );
  }

  if (jobId !== undefined && !JOB_ID_REGEX.test(jobId)) {
    return badRequestResponse('Invalid jobId format', 'INVALID_JOB_ID');
  }

  if (
    blobPath !== undefined &&
    !isValidTranscriptBlobPath(blobPath, session.user.id)
  ) {
    return badRequestResponse('Invalid blobPath', 'INVALID_BLOB_PATH');
  }

  const results: {
    jobDeleted?: boolean;
    blobDeleted?: boolean;
    errors?: string[];
  } = { errors: [] };

  // Delete transcription job if jobId provided
  if (jobId) {
    // If this jobId matches a known chunked job owned by the user, also
    // remove the local chunk files so aborted/timed-out jobs don't leave
    // their chunks behind in tmpdir.
    const ownedChunkedJob = getJobForUser(jobId, session.user.id);
    if (ownedChunkedJob && ownedChunkedJob.chunkPaths.length > 0) {
      try {
        await cleanupChunks(ownedChunkedJob.chunkPaths);
      } catch (error) {
        console.warn(
          '[TranscriptionCleanup] Failed to remove chunks for job',
          sanitizeForLog(jobId),
          error,
        );
      }
    }

    try {
      const batchService = new BatchTranscriptionService();
      if (batchService.isConfigured()) {
        await batchService.deleteTranscription(jobId);
        results.jobDeleted = true;
        console.log(
          `[TranscriptionCleanup] Deleted transcription job: ${sanitizeForLog(jobId)}`,
        );
      } else {
        // For chunked jobs there's no remote batch service to call; treat
        // chunk cleanup above as the successful path.
        if (ownedChunkedJob) {
          results.jobDeleted = true;
        } else {
          results.errors?.push('Batch transcription service not configured');
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.warn(
        `[TranscriptionCleanup] Failed to delete transcription job ${sanitizeForLog(jobId)}:`,
        errorMessage,
      );
      results.errors?.push(`Job deletion failed: ${errorMessage}`);
    }
  }

  // Delete blob if blobPath provided
  if (blobPath) {
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

      const blobClient = blobStorage.getBlockBlobClient(blobPath);
      const exists = await blobClient.exists();

      if (exists) {
        await blobClient.delete();
        results.blobDeleted = true;
        console.log(
          `[TranscriptionCleanup] Deleted blob: ${sanitizeForLog(blobPath)}`,
        );
      } else {
        console.log(
          `[TranscriptionCleanup] Blob not found (already deleted?): ${sanitizeForLog(blobPath)}`,
        );
        results.blobDeleted = true; // Consider it a success if already gone
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.warn(
        `[TranscriptionCleanup] Failed to delete blob ${sanitizeForLog(blobPath)}:`,
        errorMessage,
      );
      results.errors?.push(`Blob deletion failed: ${errorMessage}`);
    }
  }

  // Clean up errors array if empty
  if (results.errors?.length === 0) {
    delete results.errors;
  }

  // Return success even if some operations failed (cleanup is best-effort)
  return successResponse({
    cleaned: true,
    ...results,
  });
}
