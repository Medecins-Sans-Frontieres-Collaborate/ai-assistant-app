/**
 * GET /api/m365/digest/{jobId} → the caller's digest job (progress, then
 * the result). Unknown, expired or foreign ids are all 404.
 * DELETE /api/m365/digest/{jobId} → drops the record. The card calls it
 * once the result is in the message, so mailbox text does not sit in blob
 * storage for the retention window.
 */
import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import {
  DIGEST_JOB_ID_REGEX,
  deleteDigestJobForUser,
  getDigestJobForUser,
} from '@/lib/services/m365/digest/digestJobStore';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return unauthorizedResponse();
  const { jobId } = await params;
  if (!DIGEST_JOB_ID_REGEX.test(jobId)) {
    return badRequestResponse('Invalid job id');
  }
  try {
    const job = await getDigestJobForUser(
      createBlobStorageClient(session),
      session.user.id,
      jobId,
    );
    if (!job) return notFoundResponse('Digest job');
    return successResponse({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      ...(job.result && { result: job.result }),
      ...(job.error && { error: job.error }),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to read digest job');
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return unauthorizedResponse();
  const { jobId } = await params;
  if (!DIGEST_JOB_ID_REGEX.test(jobId)) {
    return badRequestResponse('Invalid job id');
  }
  try {
    const deleted = await deleteDigestJobForUser(
      createBlobStorageClient(session),
      session.user.id,
      jobId,
    );
    if (!deleted) return notFoundResponse('Digest job');
    return successResponse({ jobId, deleted: true });
  } catch (error) {
    return handleApiError(error, 'Failed to delete digest job');
  }
}
