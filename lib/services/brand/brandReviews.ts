/**
 * Where a person's brand reviews live and how one is started, read,
 * stopped and removed (docs/DOCUMENT_PLATFORM.md, phase F). The routes in
 * app/api/brand-review are thin over this.
 *
 * A review is a background job (brandReviewJob.ts) whose state, findings
 * included, is kept at `<user>/brand-reviews/<review id>/job.json`. The
 * document reviewed stays the person's upload; nothing else is stored.
 */
import { Session } from 'next-auth';

import { AdminBrandBook } from '@/lib/services/agentAccess/types';
import {
  isStalled,
  readJob,
  resumeJob,
  startJob,
  stopJob,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import { BlobJobSlots } from '@/lib/services/backgroundJobs/blobJobSlots';
import { BlobJobStore } from '@/lib/services/backgroundJobs/blobJobStore';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { inspectDocument } from '@/lib/services/documents/model/inspect';
import { documentPagePictures } from '@/lib/services/documents/render/documentPages';
import { readDocumentSource } from '@/lib/services/documents/sources/documentSources';
import { resolveVisionWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';

import { parseBrandFileRef, readStoredBrandFile } from './brandBooks';
import { reviewPage } from './brandPageReview';
import {
  BRAND_REVIEW_JOB_KIND,
  BrandReviewContext,
  BrandReviewRequest,
  BrandReviewState,
} from './brandReviewJob';

import { randomBytes } from 'crypto';

/** A review's id: `review-` and 12 hex digits. */
export const REVIEW_ID_PATTERN = /^review-[a-f0-9]{12}$/;

/** An upload reference the review reads: `/api/file/<sha256>.<ext>`. */
const UPLOAD_REF = /^\/api\/file\/([a-f0-9]{64}\.([a-z0-9]{2,5}))$/;

/** The types a review reads: those with pages and a document model. */
export const REVIEWABLE_TYPES: readonly string[] = [
  'pdf',
  'docx',
  'doc',
  'odt',
  'rtf',
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'ppt',
  'pps',
  'pot',
  'odp',
];

/** A review id that cannot be guessed. */
export function newReviewId(): string {
  return `review-${randomBytes(6).toString('hex')}`;
}

/** Where a review's state and the person's review slots are kept. */
function placeOf(session: Session, reviewId: string) {
  const storage = createBlobStorageClient(session);
  const userId = getUserIdFromSession(session);
  return {
    store: new BlobJobStore(storage, `${userId}/brand-reviews/${reviewId}/`),
    slots: new BlobJobSlots(storage, userId, 'brand-reviews/active.json'),
    key: reviewId,
  };
}

/** The upload a request names, or null when it names none of the person's. */
export function parseReviewUpload(
  ref: string,
): { id: string; type: string } | null {
  const match = UPLOAD_REF.exec(ref);
  if (!match || !REVIEWABLE_TYPES.includes(match[2])) return null;
  return { id: match[1], type: match[2] };
}

/** What a review does its work with, for this person. */
function contextFor(
  session: Session,
  request: BrandReviewRequest,
): BrandReviewContext {
  const upload = parseReviewUpload(request.file);
  return {
    user: session.user,
    deps: {
      readDocument: async () => {
        const file =
          upload &&
          (await readDocumentSource(session, {
            kind: 'upload',
            id: upload.id,
            type: upload.type,
          }));
        if (!file)
          throw new Error('The document to review is no longer stored.');
        return file.data;
      },
      readLogo: async (file) => {
        const ref = parseBrandFileRef(file);
        if (!ref || ref.kind !== 'stored' || ref.bookId !== request.book.id) {
          return null;
        }
        const stored = await readStoredBrandFile(ref.bookId, ref.name);
        return stored?.data ?? null;
      },
      inspect: inspectDocument,
      pagePictures: documentPagePictures,
      reviewPage,
      model: resolveVisionWorkflowModelId(),
    },
  };
}

/**
 * Reads the locale a review's notes are written in: a well-formed BCP 47
 * tag, canonicalised, or English for anything else.
 *
 * @param value - The request's `locale`, unchecked.
 * @returns A canonical tag such as `pt-BR`.
 */
export function parseNoteLocale(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 35) return 'en';
  try {
    return Intl.getCanonicalLocales(value)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * Starts a review of one of the person's uploads against a book they may
 * use (the caller has checked that, and passes the book as read).
 *
 * @throws JobActiveError when the person's reviews are all in use.
 */
export async function startBrandReview(
  session: Session,
  book: AdminBrandBook,
  upload: { file: string; name: string; type: string },
  options: { modelReview: boolean; noteLocale: string },
): Promise<{ reviewId: string; state: BrandReviewState }> {
  const reviewId = newReviewId();
  const request: BrandReviewRequest = {
    book: {
      id: book.id,
      name: book.book.name,
      updatedAt: book.updatedAt,
      body: book.book,
    },
    file: upload.file,
    name: upload.name,
    type: upload.type,
    modelReview: options.modelReview,
    noteLocale: options.noteLocale,
  };
  const state = await startJob(
    BRAND_REVIEW_JOB_KIND,
    { ...placeOf(session, reviewId), context: contextFor(session, request) },
    request,
  );
  return { reviewId, state };
}

/**
 * A review as stored, picked up again when its runner has gone quiet
 * (a restarted server).
 *
 * @returns The state, or null when the person has no such review.
 */
export async function readBrandReview(
  session: Session,
  reviewId: string,
): Promise<BrandReviewState | null> {
  const place = placeOf(session, reviewId);
  const state = await readJob<BrandReviewState>(
    BRAND_REVIEW_JOB_KIND,
    place.store,
  );
  if (!state) return null;
  if (isStalled(BRAND_REVIEW_JOB_KIND.kind, reviewId, state, Date.now())) {
    return resumeJob(
      BRAND_REVIEW_JOB_KIND,
      { ...place, context: contextFor(session, state.request) },
      state,
    );
  }
  return state;
}

/** Asks a running review to stop; it keeps what it found. */
export async function stopBrandReview(
  session: Session,
  reviewId: string,
): Promise<BrandReviewState | null> {
  const place = placeOf(session, reviewId);
  const state = await readJob<BrandReviewState>(
    BRAND_REVIEW_JOB_KIND,
    place.store,
  );
  if (!state) return null;
  return stopJob(BRAND_REVIEW_JOB_KIND, reviewId, place.store, state);
}

/** Stops a review if it runs, and deletes what is stored of it. */
export async function removeBrandReview(
  session: Session,
  reviewId: string,
): Promise<boolean> {
  const place = placeOf(session, reviewId);
  const state = await readJob<BrandReviewState>(
    BRAND_REVIEW_JOB_KIND,
    place.store,
  );
  if (!state) return false;
  await stopJob(BRAND_REVIEW_JOB_KIND, reviewId, place.store, state);
  await place.slots.release(reviewId);
  await place.store.remove();
  return true;
}
