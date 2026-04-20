/**
 * Transcription Status Polling Endpoint
 *
 * Polls the status of a transcription job (chunked or batch) and returns
 * the transcript when the job is complete.
 *
 * Supports two job types:
 * - Chunked: In-memory jobs processed locally (preferred for large files)
 * - Batch: Azure Speech Services batch API (legacy, kept for backwards compatibility)
 *
 * GET /api/transcription/status/[jobId]
 */
import { NextRequest, NextResponse } from 'next/server';

import { BatchTranscriptionService } from '@/lib/services/transcription/batchTranscriptionService';
import {
  JOB_CANCELLED_MESSAGE,
  JOB_ID_REGEX,
  getJobForUser,
} from '@/lib/services/transcription/chunkedJobStore';

import {
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  // Verify authentication
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const { jobId } = await params;

  if (!jobId) {
    return NextResponse.json({ error: 'Job ID is required' }, { status: 400 });
  }

  // Distinguish "malformed jobId" from "not found / not yours" — they mean
  // different things for the client.
  if (!JOB_ID_REGEX.test(jobId)) {
    return NextResponse.json(
      { error: 'Invalid jobId format', code: 'INVALID_JOB_ID' },
      { status: 400 },
    );
  }

  // First, check if this is a chunked transcription job owned by this user.
  // getJobForUser returns undefined on ownership mismatch, which is
  // indistinguishable from "not found" — prevents jobId enumeration.
  const chunkedJob = getJobForUser(jobId, session.user.id);
  if (chunkedJob) {
    // Map internal status to API status. Cancelled collapses into Failed
    // for the wire format so existing clients don't need to learn a new
    // status literal; the message carries the distinction.
    let status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed';
    switch (chunkedJob.status) {
      case 'pending':
        status = 'NotStarted';
        break;
      case 'processing':
        status = 'Running';
        break;
      case 'succeeded':
        status = 'Succeeded';
        break;
      case 'failed':
      case 'cancelled':
        status = 'Failed';
        break;
    }

    const cancelled = chunkedJob.status === 'cancelled';
    return successResponse({
      status,
      transcript: chunkedJob.transcript,
      error: cancelled ? JOB_CANCELLED_MESSAGE : chunkedJob.error,
      // Expose classification so the client can pick appropriate recovery UX
      // (retry vs re-auth vs "try a different file"). Absent for non-failures.
      errorClass: cancelled ? undefined : chunkedJob.errorClass,
      cancelled: cancelled || undefined,
      progress: {
        completed: chunkedJob.completedChunks,
        total: chunkedJob.totalChunks,
      },
      jobType: 'chunked',
      createdAt: new Date(chunkedJob.createdAt).toISOString(),
      message:
        status === 'NotStarted'
          ? 'Transcription job is queued'
          : status === 'Running'
            ? `Processing chunk ${chunkedJob.completedChunks + 1} of ${chunkedJob.totalChunks}`
            : undefined,
    });
  }

  // Fall back to batch transcription service (legacy)
  const batchService = new BatchTranscriptionService();

  // Check if service is configured
  if (!batchService.isConfigured()) {
    // If neither chunked nor batch job found, return not found
    return errorResponse(
      'Transcription job not found',
      404,
      `Job ${jobId} not found in chunked or batch systems`,
    );
  }

  try {
    // Get the current status of the batch job
    const status = await batchService.getStatus(jobId);

    // If the job succeeded, also fetch the transcript
    if (status.status === 'Succeeded') {
      const transcript = await batchService.getTranscript(jobId);

      return successResponse({
        status: status.status,
        transcript,
        jobType: 'batch',
        createdAt: status.createdDateTime,
        completedAt: status.lastUpdatedDateTime,
      });
    }

    // If the job failed, return error details
    if (status.status === 'Failed') {
      return successResponse({
        status: status.status,
        error: status.error || 'Transcription failed',
        jobType: 'batch',
        createdAt: status.createdDateTime,
      });
    }

    // Job is still processing
    return successResponse({
      status: status.status,
      jobType: 'batch',
      createdAt: status.createdDateTime,
      message:
        status.status === 'NotStarted'
          ? 'Transcription job is queued'
          : 'Transcription in progress',
    });
  } catch (error) {
    console.error('Error polling transcription status:', error);
    return errorResponse(
      'Failed to get transcription status',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
