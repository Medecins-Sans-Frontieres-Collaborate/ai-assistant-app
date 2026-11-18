/**
 * Resolves the caller's translation job for the document-translation routes.
 *
 * Every route under `/api/document-translation/…/{jobId}` needs the same three
 * steps: a signed-in user, a well-formed job id, and a job record that
 * belongs to that user. This is the one place that does them, so a new route
 * cannot forget the ownership check.
 */
import { NextResponse } from 'next/server';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import {
  TRANSLATION_JOB_ID_REGEX,
  TranslationJob,
  getTranslationJobForUser,
} from './translationJobStore';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/** The caller's job with the storage it lives in, or the response to return. */
export type OwnedTranslationJob =
  | { ok: true; storage: AzureBlobStorage; job: TranslationJob }
  | { ok: false; response: NextResponse };

/**
 * Authenticates the caller and loads one of their translation jobs.
 *
 * @param jobId - Job id from the route parameters (untrusted).
 * @returns The job and the user-data storage, or a ready 401/400/404
 *   response. A job owned by someone else is reported as not found, so job
 *   ids cannot be enumerated.
 */
export async function resolveOwnedTranslationJob(
  jobId: string,
): Promise<OwnedTranslationJob> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, response: unauthorizedResponse() };
  }
  if (!TRANSLATION_JOB_ID_REGEX.test(jobId)) {
    return {
      ok: false,
      response: badRequestResponse('Invalid job id', 'INVALID_JOB_ID'),
    };
  }

  const storage = new AzureBlobStorage(
    getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user: session.user }),
    getEnvVariable({
      name: 'AZURE_BLOB_STORAGE_CONTAINER',
      throwErrorOnFail: false,
      defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
      user: session.user,
    }),
    session.user,
  );
  const job = await getTranslationJobForUser(storage, jobId, session.user.id);
  if (!job) {
    return { ok: false, response: notFoundResponse('Translation job') };
  }
  return { ok: true, storage, job };
}
