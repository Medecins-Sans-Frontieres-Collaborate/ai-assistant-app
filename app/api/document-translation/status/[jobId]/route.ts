/**
 * Async (batch) document translation status endpoint.
 *
 * GET /api/document-translation/status/{jobId}
 *
 * Proxies Azure's batch status live (no background worker — Azure runs the
 * job). Mirrors the transcription polling contract:
 *   { status: 'Running' | 'Succeeded' | 'Failed', error?, reference? }
 * On Succeeded, `reference` is the same DocumentTranslationReference the
 * sync path returns, ready to write into the conversation.
 */
import { NextRequest } from 'next/server';

import { DocumentTranslationService } from '@/lib/services/documentTranslation/documentTranslationService';
import {
  TRANSLATION_JOB_ID_REGEX,
  getTranslationJobForUser,
} from '@/lib/services/documentTranslation/translationJobStore';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import {
  DocumentTranslationReference,
  TRANSLATION_EXPIRY_DAYS,
} from '@/types/documentTranslation';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { getDocumentTranslationLanguageByCode } from '@/lib/constants/documentTranslationLanguages';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const { jobId } = await params;
  if (!TRANSLATION_JOB_ID_REGEX.test(jobId)) {
    return badRequestResponse('Invalid job id', 'INVALID_JOB_ID');
  }

  // Missing and not-owned are indistinguishable — prevents enumeration.
  const job = getTranslationJobForUser(jobId, session.user.id);
  if (!job) {
    return notFoundResponse('Translation job not found');
  }

  try {
    const translationService = new DocumentTranslationService();
    const batch = await translationService.getBatchTranslationStatus(
      job.operationId,
    );

    if (batch.status === 'Failed') {
      return successResponse({
        status: 'Failed' as const,
        error: batch.error ?? 'Translation failed',
      });
    }

    if (batch.status === 'Succeeded') {
      // Azure can report success momentarily before the target blob is
      // visible; keep the client polling until the download would work.
      const blobStorage = new AzureBlobStorage(
        getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user: session.user }),
        getEnvVariable({
          name: 'AZURE_BLOB_STORAGE_CONTAINER',
          throwErrorOnFail: false,
          defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
          user: session.user,
        }),
        session.user,
      );
      const blobPath = `${session.user.id}/translations/${job.jobId}.${job.ext}`;
      if (!(await blobStorage.blobExists(blobPath))) {
        return successResponse({ status: 'Running' as const });
      }

      const expiresAt = new Date(
        job.createdAt + TRANSLATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      );
      const targetLangInfo = getDocumentTranslationLanguageByCode(
        job.targetLanguage,
      );
      const reference: DocumentTranslationReference = {
        originalFilename: job.filename,
        originalFileUrl: `/api/document-translation/content/${job.jobId}?filename=${encodeURIComponent(job.filename)}&ext=${job.ext}&original=true`,
        translatedFilename: job.translatedFilename,
        jobId: job.jobId,
        blobPath,
        expiresAt: expiresAt.toISOString(),
        targetLanguage: job.targetLanguage,
        targetLanguageName: targetLangInfo?.englishName ?? job.targetLanguage,
        fileExtension: job.ext,
      };
      return successResponse({ status: 'Succeeded' as const, reference });
    }

    return successResponse({ status: 'Running' as const });
  } catch (error) {
    // Azure poll failure is transient from the client's perspective — keep
    // it polling rather than surfacing a terminal failure.
    console.error(
      '[DocumentTranslation] Status poll failed:',
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      'Failed to check translation status',
      502,
      undefined,
      'STATUS_CHECK_FAILED',
    );
  }
}
