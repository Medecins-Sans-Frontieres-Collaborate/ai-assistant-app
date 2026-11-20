import type { Session } from 'next-auth';

import { removeBrandReview } from '@/lib/services/brand/brandReviews';
import { removeDeckJob } from '@/lib/services/deckBuilder/deckBuilds';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Removing deck work, with what it started. */

const jobs = vi.hoisted(() => ({
  byFolder: new Map<
    string,
    { read: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
  >(),
}));

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/backgroundJobs/personJobs', async () => {
  const { vi: hoistedVi } = await import('vitest');
  return {
    personJobs: (_kind: unknown, folder: string) => {
      const fake = {
        read: hoistedVi.fn(),
        remove: hoistedVi.fn(async () => true),
        start: hoistedVi.fn(),
        stop: hoistedVi.fn(),
      };
      jobs.byFolder.set(folder, fake);
      return fake;
    },
  };
});
vi.mock('@/lib/services/brand/brandReviews', () => ({
  readBrandReview: vi.fn(),
  removeBrandReview: vi.fn(async () => true),
  startBrandReview: vi.fn(),
}));

const session = { user: { id: 'u1' } } as Session;
const BUILD = 'deck-aaaaaaaaaaaa';

describe('removeDeckJob', () => {
  beforeEach(() => vi.mocked(removeBrandReview).mockClear());

  it('removes a build with the brand review it started', async () => {
    const builds = jobs.byFolder.get('deck-builds')!;
    builds.read.mockResolvedValueOnce({ reviewId: 'review-bbbbbbbbbbbb' });
    expect(await removeDeckJob(session, BUILD)).toBe(true);
    expect(removeBrandReview).toHaveBeenCalledWith(
      session,
      'review-bbbbbbbbbbbb',
    );
    expect(builds.remove).toHaveBeenCalledWith(session, BUILD);
  });

  it('removes a build that started no review, and nothing else', async () => {
    const builds = jobs.byFolder.get('deck-builds')!;
    builds.read.mockResolvedValueOnce({ reviewId: null });
    expect(await removeDeckJob(session, BUILD)).toBe(true);
    expect(removeBrandReview).not.toHaveBeenCalled();
  });

  it('removes an outline, and refuses any other id', async () => {
    expect(await removeDeckJob(session, 'outline-aaaaaaaaaaaa')).toBe(true);
    expect(jobs.byFolder.get('deck-outlines')!.remove).toHaveBeenCalled();
    expect(await removeDeckJob(session, 'review-aaaaaaaaaaaa')).toBe(false);
  });
});
