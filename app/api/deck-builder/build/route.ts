import { NextRequest } from 'next/server';

import { JobActiveError } from '@/lib/services/backgroundJobs/backgroundJobs';
import { usableBrandBook } from '@/lib/services/brand/brandBooks';
import { parseNoteLocale } from '@/lib/services/brand/brandReviews';
import type { DeckOutlineState } from '@/lib/services/deckBuilder/deckBuilderJobs';
import {
  DeckPlanBlockedError,
  OUTLINE_ID_PATTERN,
  readDeckJob,
  startDeckBuild,
} from '@/lib/services/deckBuilder/deckBuilds';
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
import { DeckPlanSchema } from '@/lib/utils/shared/documents/deckPlan';

import { auth } from '@/auth';
import { z } from 'zod';

const BuildBodySchema = z.object({
  outlineId: z.string().regex(OUTLINE_ID_PATTERN),
  plan: DeckPlanSchema,
  name: z.string().trim().min(1).max(120),
  locale: z.string().optional(),
});

/**
 * POST /api/deck-builder/build: builds a deck from a finished outline and
 * the plan as the person edited it, checked again against the outline's
 * layouts. Answers 202 at once; GET /api/deck-builder/<id> follows it.
 *
 * Body: `{ outlineId, plan, name, locale }`. A plan that cannot be built
 * answers 422 with the problems, in words, as `details.problems`.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('deck-builder'))) {
    return workflowDisabledResponse('deck-builder');
  }
  const parsed = BuildBodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return badRequestResponse('Invalid build request');
  const body = parsed.data;
  try {
    const outline = (await readDeckJob(
      session,
      body.outlineId,
    )) as DeckOutlineState | null;
    if (!outline || outline.status !== 'done') {
      return notFoundResponse('Outline');
    }
    // The book must still be one the person may use.
    const bookId = outline.request.book?.id;
    if (bookId && !(await usableBrandBook(session, bookId, request))) {
      return notFoundResponse('Brand book');
    }
    const { denied } = await beginWorkflowRun(session, 'deck-builder');
    if (denied) return denied;
    const started = await startDeckBuild(session, {
      outlineId: body.outlineId,
      plan: body.plan,
      name:
        body.name
          .replace(/[\\/:*?"<>|]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || 'Deck',
      noteLocale: parseNoteLocale(body.locale),
    });
    if (!started) return notFoundResponse('Outline');
    return successResponse(started, undefined, 202);
  } catch (error) {
    if (error instanceof DeckPlanBlockedError) {
      return errorResponse(
        error.message,
        422,
        { problems: error.problems },
        'PLAN_BLOCKED',
      );
    }
    if (error instanceof JobActiveError) {
      return errorResponse(
        error.message,
        409,
        { activeName: error.active.label, activeId: error.active.key },
        error.code,
      );
    }
    return handleApiError(error, 'Failed to start the build');
  }
}
