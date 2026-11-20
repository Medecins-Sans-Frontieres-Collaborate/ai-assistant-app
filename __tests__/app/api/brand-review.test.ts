import { NextRequest } from 'next/server';

import { JobActiveError } from '@/lib/services/backgroundJobs/backgroundJobs';
import { usableBrandBook } from '@/lib/services/brand/brandBooks';
import {
  readBrandReview,
  startBrandReview,
} from '@/lib/services/brand/brandReviews';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import { GET } from '@/app/api/brand-review/[id]/route';
import { POST } from '@/app/api/brand-review/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Starting and reading brand reviews: the gates in front of the job. */

const mockAuth = vi.hoisted(() => vi.fn());

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: vi.fn(),
  workflowDisabledResponse: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi.fn(),
}));
vi.mock('@/lib/services/brand/brandBooks', () => ({
  usableBrandBook: vi.fn(),
}));
vi.mock('@/lib/services/brand/brandReviews', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startBrandReview: vi.fn(),
  readBrandReview: vi.fn(),
}));

const BOOK = 'brand-aaaaaaaaaaaa';
const FILE = `/api/file/${'a'.repeat(64)}.pdf`;
const post = (body: unknown) =>
  POST(
    new NextRequest('https://app.example.com/api/brand-review', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

describe('/api/brand-review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(isWorkflowEnabled).mockResolvedValue(true);
    vi.mocked(beginWorkflowRun).mockResolvedValue({ denied: null } as never);
    vi.mocked(usableBrandBook).mockResolvedValue({ id: BOOK } as never);
    vi.mocked(startBrandReview).mockResolvedValue({
      reviewId: 'review-aaaaaaaaaaaa',
      state: { status: 'running' },
    } as never);
  });

  it('needs a person and the workflow switched on', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post({ bookId: BOOK, file: FILE })).status).toBe(401);
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    vi.mocked(isWorkflowEnabled).mockResolvedValue(false);
    expect((await post({ bookId: BOOK, file: FILE })).status).toBe(403);
  });

  it('refuses a malformed book, and a file that is not a reviewable upload', async () => {
    expect((await post({ bookId: 'nope', file: FILE })).status).toBe(400);
    for (const file of [
      `/api/file/${'a'.repeat(64)}.png`,
      'https://example.com/x.pdf',
      `/api/file/../${'a'.repeat(64)}.pdf`,
    ]) {
      expect((await post({ bookId: BOOK, file })).status).toBe(400);
    }
    expect(startBrandReview).not.toHaveBeenCalled();
  });

  it('answers 404 for a book the person may not use', async () => {
    vi.mocked(usableBrandBook).mockResolvedValue(null);
    expect((await post({ bookId: BOOK, file: FILE })).status).toBe(404);
  });

  it('starts with the budget checked only when a model is used', async () => {
    const response = await post({
      bookId: BOOK,
      file: FILE,
      name: 'Annual.pdf',
      modelReview: false,
    });
    expect(response.status).toBe(202);
    expect(beginWorkflowRun).not.toHaveBeenCalled();
    expect(vi.mocked(startBrandReview).mock.calls[0].slice(2)).toEqual([
      { file: FILE, name: 'Annual.pdf', type: 'pdf' },
      false,
    ]);
    await post({ bookId: BOOK, file: FILE });
    expect(beginWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('answers 409 naming the review in the way', async () => {
    vi.mocked(startBrandReview).mockRejectedValue(
      new JobActiveError('brand-review', {
        key: 'review-bbbbbbbbbbbb',
        label: 'Other.pdf',
        heartbeatAt: 0,
      }),
    );
    const response = await post({ bookId: BOOK, file: FILE });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain('Other.pdf');
  });

  it('reads only a well-formed review id, and 404s one not stored', async () => {
    const read = (id: string) =>
      GET(new NextRequest('https://app.example.com/x'), {
        params: Promise.resolve({ id }),
      });
    expect((await read('../etc')).status).toBe(404);
    expect(readBrandReview).not.toHaveBeenCalled();
    vi.mocked(readBrandReview).mockResolvedValue(null);
    expect((await read('review-aaaaaaaaaaaa')).status).toBe(404);
  });
});
