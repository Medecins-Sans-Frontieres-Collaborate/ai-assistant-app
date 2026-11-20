import { NextRequest } from 'next/server';

import { BRAND_BOOK_ID_PATTERN } from '@/lib/services/agentAccess/types';
import { JobActiveError } from '@/lib/services/backgroundJobs/backgroundJobs';
import { usableBrandBook } from '@/lib/services/brand/brandBooks';
import {
  parseNoteLocale,
  parseReviewUpload,
  startBrandReview,
} from '@/lib/services/brand/brandReviews';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * POST /api/brand-review: starts a brand review of one of the person's
 * uploads against a brand book they may use (docs/DOCUMENT_PLATFORM.md,
 * phase F). Answers 202 at once with the review's first state; the work
 * goes on in the background (GET /api/brand-review/<id>).
 *
 * Body: `{ bookId, file: "/api/file/<sha256>.<ext>", name, modelReview,
 * locale }`; the locale is the reader's, which the model's notes are in.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('brand-review'))) {
    return workflowDisabledResponse('brand-review');
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const bookId = typeof body.bookId === 'string' ? body.bookId : '';
  const file = typeof body.file === 'string' ? body.file : '';
  const upload = parseReviewUpload(file);
  if (!BRAND_BOOK_ID_PATTERN.test(bookId)) {
    return badRequestResponse('bookId is not a brand book id');
  }
  if (!upload) {
    return badRequestResponse(
      'file must be an uploaded PDF, Word document or presentation',
      'UNSUPPORTED_DOCUMENT',
    );
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 200)
      : upload.id;
  const modelReview = body.modelReview !== false;

  try {
    const book = await usableBrandBook(session, bookId, request);
    if (!book) return notFoundResponse('Brand book');
    if (modelReview) {
      const { denied } = await beginWorkflowRun(session, 'brand-review');
      if (denied) return denied;
    }
    const started = await startBrandReview(
      session,
      book,
      { file, name, type: upload.type },
      { modelReview, noteLocale: parseNoteLocale(body.locale) },
    );
    return successResponse(started, undefined, 202);
  } catch (error) {
    if (error instanceof JobActiveError) {
      return errorResponse(
        error.message,
        409,
        { activeName: error.active.label, activeReviewId: error.active.key },
        error.code,
      );
    }
    return handleApiError(error, 'Failed to start the brand review');
  }
}
