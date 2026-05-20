/**
 * Transcription API Endpoint
 *
 * Routes transcription requests based on file size:
 * - Files ≤25MB: Whisper (synchronous, returns transcript directly)
 * - Files >25MB: Azure Speech Batch (async, returns job ID for polling)
 *
 * GET /api/file/[id]/transcribe
 */
import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { BatchTranscriptionService } from '@/lib/services/transcription/batchTranscriptionService';
import { TranscriptionServiceFactory } from '@/lib/services/transcriptionService';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { unauthorizedResponse } from '@/lib/utils/server/api/apiResponse';

import { TranscriptionResponse } from '@/types/transcription';

import { auth } from '@/auth';
import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session: Session | null = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  const { id } = await params;

  let transcript: string | undefined;

  try {
    const userId = getUserIdFromSession(session);
    const blobStorageClient = createBlobStorageClient(session);

    const filePath = `${userId}/uploads/files/${id}`;
    const blockBlobClient = blobStorageClient.getBlockBlobClient(filePath);

    // Get file size to determine which service to use
    const properties = await blockBlobClient.getProperties();
    const fileSize = properties.contentLength || 0;

    // Determine which transcription service to use based on file size
    const serviceType =
      TranscriptionServiceFactory.getServiceTypeForFileSize(fileSize);

    if (serviceType === 'whisper') {
      // Synchronous transcription for small files (≤25MB)
      const tmpFilePath = join(tmpdir(), `${Date.now()}_${id}`);
      await blockBlobClient.downloadToFile(tmpFilePath);

      const transcriptionService =
        TranscriptionServiceFactory.getTranscriptionService('whisper');

      transcript = await transcriptionService.transcribe(tmpFilePath);

      await unlinkAsync(tmpFilePath);
      // Delete the blob after successful transcription
      await blockBlobClient.delete();

      const response: TranscriptionResponse = {
        async: false,
        transcript,
      };
      return NextResponse.json(response);
    } else {
      // Asynchronous batch transcription for large files (>25MB)
      const batchService = new BatchTranscriptionService();

      // Check if batch service is configured
      if (!batchService.isConfigured()) {
        // Fall back to error - batch service not available
        return NextResponse.json(
          {
            message:
              'File too large for standard transcription (>25MB) and batch transcription is not configured',
            error: 'BATCH_SERVICE_NOT_CONFIGURED',
          },
          { status: 503 },
        );
      }

      // Generate a SAS URL for the blob (batch API needs public access)
      const sasUrl = await blobStorageClient.generateSasUrl(filePath, 24);

      // Submit the batch transcription job
      const jobId = await batchService.submitTranscription(sasUrl);

      // Note: We don't delete the blob yet - it will be deleted after
      // the batch job completes and the transcript is retrieved

      const response: TranscriptionResponse = {
        async: true,
        jobId,
      };
      return NextResponse.json(response);
    }
  } catch (error) {
    console.error('Error during transcription:', error);

    // If we have a partial transcript (unlikely), return it
    if (transcript) {
      const response: TranscriptionResponse = {
        async: false,
        transcript,
      };
      return NextResponse.json(response);
    }

    return NextResponse.json(
      {
        message: 'Failed to transcribe audio',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
