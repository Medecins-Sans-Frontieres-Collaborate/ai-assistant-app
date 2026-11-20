import { NextRequest } from 'next/server';

import { BRAND_BOOK_ID_PATTERN } from '@/lib/services/agentAccess/types';
import { JobActiveError } from '@/lib/services/backgroundJobs/backgroundJobs';
import { usableBrandBook } from '@/lib/services/brand/brandBooks';
import { parseNoteLocale } from '@/lib/services/brand/brandReviews';
import { startDeckOutline } from '@/lib/services/deckBuilder/deckBuilds';
import { DeckInputError } from '@/lib/services/deckBuilder/deckInputs';
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
import { z } from 'zod';

/** An upload as a request names it. */
const UploadSchema = z.object({
  file: z.string().max(200),
  name: z.string().trim().min(1).max(200),
});

const OutlineBodySchema = z.object({
  template: UploadSchema,
  bookId: z.string().optional(),
  brief: z.string().max(20_000),
  sources: z.array(UploadSchema).max(20).default([]),
  pictures: z.array(UploadSchema).max(20).default([]),
  language: z.string().optional(),
});

/**
 * POST /api/deck-builder: starts an outline of a deck from a brief,
 * sources and a template (docs/DOCUMENT_PLATFORM.md, phase G). Answers 202
 * at once; the plan is made in the background (GET /api/deck-builder/<id>).
 *
 * Body: `{ template: {file, name}, bookId?, brief, sources: [{file, name}],
 * pictures: [{file, name}], language }`. The template is one of the book's
 * deck templates or the person's own .pptx or .potx upload.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('deck-builder'))) {
    return workflowDisabledResponse('deck-builder');
  }
  const parsed = OutlineBodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return badRequestResponse('Invalid outline request');
  const body = parsed.data;
  if (body.bookId !== undefined && !BRAND_BOOK_ID_PATTERN.test(body.bookId)) {
    return badRequestResponse('bookId is not a brand book id');
  }
  try {
    const book = body.bookId
      ? await usableBrandBook(session, body.bookId, request)
      : null;
    if (body.bookId && !book) return notFoundResponse('Brand book');
    const { denied } = await beginWorkflowRun(session, 'deck-builder');
    if (denied) return denied;
    const started = await startDeckOutline(session, {
      template: { ...body.template, type: '' },
      book,
      brief: body.brief,
      sources: body.sources,
      pictures: body.pictures,
      language: parseNoteLocale(body.language),
    });
    return successResponse(started, undefined, 202);
  } catch (error) {
    if (error instanceof DeckInputError) {
      return badRequestResponse(error.message, 'DECK_INPUT');
    }
    if (error instanceof JobActiveError) {
      return errorResponse(
        error.message,
        409,
        { activeName: error.active.label, activeId: error.active.key },
        error.code,
      );
    }
    return handleApiError(error, 'Failed to start the outline');
  }
}
