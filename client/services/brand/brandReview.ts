'use client';

import type { BrandReviewState } from '@/lib/services/brand/brandReviewJob';

/**
 * The browser's side of brand reviews (app/api/brand-review) and of the
 * brand books a person may review against (app/api/brand-books).
 */

/** A brand book as the person's list shows it. */
export interface UsableBrandBook {
  id: string;
  name: string;
  description: string;
  colors: string[];
  updatedAt: string;
}

/** A review as read. */
export interface BrandReviewReading {
  reviewId: string;
  state: BrandReviewState;
}

/** A review refused because the person's reviews are all running. */
export class BrandReviewBusyError extends Error {
  constructor(
    message: string,
    readonly activeName: string | null,
  ) {
    super(message);
    this.name = 'BrandReviewBusyError';
  }
}

/** A review that is no longer stored (removed, or expired). */
export class BrandReviewGoneError extends Error {
  constructor() {
    super('This brand review is no longer stored.');
    this.name = 'BrandReviewGoneError';
  }
}

async function dataOf<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (response.status === 409) {
    throw new BrandReviewBusyError(
      body?.error ?? fallback,
      typeof body?.details?.activeName === 'string'
        ? body.details.activeName
        : null,
    );
  }
  if (response.status === 404) throw new BrandReviewGoneError();
  if (!response.ok || !body?.success) {
    throw new Error(body?.error || `${fallback} (${response.status})`);
  }
  return body.data as T;
}

/** The brand books the person may review against. */
export async function listUsableBrandBooks(): Promise<UsableBrandBook[]> {
  const data = await dataOf<{ books: UsableBrandBook[] }>(
    await fetch('/api/brand-books'),
    'Could not load brand books',
  );
  return data.books;
}

/**
 * Starts a review.
 *
 * @throws BrandReviewBusyError when the person's reviews are all running.
 */
export async function startBrandReview(input: {
  bookId: string;
  file: string;
  name: string;
  modelReview: boolean;
}): Promise<BrandReviewReading> {
  return dataOf(
    await fetch('/api/brand-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    'Could not start the brand review',
  );
}

/**
 * Reads a review.
 *
 * @throws BrandReviewGoneError when it is no longer stored.
 */
export async function readBrandReview(
  reviewId: string,
  signal?: AbortSignal,
): Promise<BrandReviewReading> {
  return dataOf(
    await fetch(`/api/brand-review/${encodeURIComponent(reviewId)}`, {
      signal,
    }),
    'Could not read the brand review',
  );
}

/** Asks a running review to stop. */
export async function stopBrandReview(
  reviewId: string,
): Promise<BrandReviewReading> {
  return dataOf(
    await fetch(`/api/brand-review/${encodeURIComponent(reviewId)}/stop`, {
      method: 'POST',
    }),
    'Could not stop the brand review',
  );
}

/** Deletes a review (stopping it first). A review already gone is fine. */
export async function removeBrandReview(reviewId: string): Promise<void> {
  try {
    await dataOf(
      await fetch(`/api/brand-review/${encodeURIComponent(reviewId)}`, {
        method: 'DELETE',
      }),
      'Could not remove the brand review',
    );
  } catch (error) {
    if (!(error instanceof BrandReviewGoneError)) throw error;
  }
}
