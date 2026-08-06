/**
 * guardLimit's rollback contract: only a reservation that ACTUALLY debited
 * counters may hand out a rollback — releasing after a fail-open (nothing
 * written) would decrement usage that was never charged.
 */
import { guardLimit } from '@/lib/services/limits/routeGuard';
import { release, reserve } from '@/lib/services/limits/usageStore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/limits/enforcement', () => ({
  currentPolicy: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
  checkCeiling: vi.fn(),
  meteredCells: vi
    .fn()
    .mockReturnValue([
      { limitKey: 'feature.upload.filesPerDay', value: 5, source: 'global' },
    ]),
  applyMode: vi.fn().mockReturnValue({ allowed: false }),
  denialMessage: vi.fn().mockReturnValue('quota exceeded'),
}));

vi.mock('@/lib/services/limits/periods', () => ({
  periodKindForWindow: vi.fn().mockReturnValue('day'),
}));

vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: vi.fn().mockReturnValue({ userId: 'user-1' }),
}));

vi.mock('@/lib/services/limits/usageStore', () => ({
  reserve: vi.fn(),
  release: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(),
}));

vi.mock('@/config/limits', () => ({
  getLimitDefinition: vi.fn().mockReturnValue({ window: 'day' }),
}));

const session = { user: { id: 'user-1' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('guardLimit rollback', () => {
  it('returns a rollback that releases exactly what was debited', async () => {
    const debited = [
      {
        cell: 'feature.upload.filesPerDay',
        cost: 1,
        limit: 5,
        limitKey: 'feature.upload.filesPerDay',
        source: 'global',
      },
    ];
    vi.mocked(reserve).mockResolvedValue({ allowed: true, debited });

    const result = await guardLimit(session, 'feature.upload.filesPerDay');
    expect(result.allowed).toBe(true);
    expect(result.rollback).toBeDefined();

    await result.rollback?.();
    expect(release).toHaveBeenCalledWith('user-1', 'day', debited, {
      timezone: 'UTC',
    });
  });

  it('gives NO rollback on fail-open — nothing was charged', async () => {
    vi.mocked(reserve).mockResolvedValue({ allowed: true, failedOpen: true });

    const result = await guardLimit(session, 'feature.upload.filesPerDay');
    expect(result.allowed).toBe(true);
    expect(result.rollback).toBeUndefined();
    expect(release).not.toHaveBeenCalled();
  });

  it('denies with a ready response when the reservation is refused', async () => {
    vi.mocked(reserve).mockResolvedValue({
      allowed: false,
      denial: {
        limitKey: 'feature.upload.filesPerDay',
        cell: 'feature.upload.filesPerDay',
        limit: 5,
        used: 5,
        resetAt: '2026-08-06T00:00:00Z',
      },
    } as never);

    const result = await guardLimit(session, 'feature.upload.filesPerDay');
    expect(result.allowed).toBe(false);
    expect(result.response?.status).toBe(403);
    expect(result.rollback).toBeUndefined();
  });
});
