/**
 * Transcription Cancel Endpoint
 *
 * Marks an in-flight chunked transcription job as cancelled. The background
 * chunk processor checks job status between batches and aborts cooperatively.
 *
 * POST /api/transcription/cancel/[jobId]
 */
import { NextRequest } from 'next/server';

import {
  JOB_ID_REGEX,
  cancelJob,
  getJobForUser,
} from '@/lib/services/transcription/chunkedJobStore';

import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const { jobId } = await params;
  if (!jobId || !JOB_ID_REGEX.test(jobId)) {
    return badRequestResponse('Invalid jobId format', 'INVALID_JOB_ID');
  }

  const job = getJobForUser(jobId, session.user.id);
  if (!job) {
    // Indistinguishable 404: either unknown job or not yours.
    return notFoundResponse('Transcription job');
  }

  try {
    cancelJob(jobId);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500,
    );
  }

  return successResponse({ cancelled: true, jobId });
}
