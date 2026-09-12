import {
  COLD_DEADLINE_MS,
  LimitsService,
  POLICY_READ_DEADLINE_MS,
} from '@/lib/services/limits/LimitsService';
import { readPolicy } from '@/lib/services/limits/limitsStore';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/limits/limitsStore', () => ({
  createLimitsBlobStorage: vi.fn(() => ({})),
  readPolicy: vi.fn(),
}));

const policy = { version: 1, mode: 'enforce', timezone: 'UTC' } as never;

/**
 * Bounded waits (efficiency/robustness review 2026-09-12): a hung policy
 * read must never park every request on the replica. Warm callers are
 * served stale-while-revalidate; cold callers wait at most COLD_DEADLINE_MS
 * and then fail open; a failed read is not re-attempted per request even
 * when nothing has ever loaded; every read carries a deadline.
 */
describe('LimitsService bounded waits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    LimitsService.resetInstance();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a read deadline to storage', async () => {
    vi.mocked(readPolicy).mockResolvedValue({ policy, etag: '"e1"' });
    await LimitsService.getInstance().ensureFresh();
    const options = vi.mocked(readPolicy).mock.calls[0][1];
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(POLICY_READ_DEADLINE_MS).toBeGreaterThan(0);
  });

  it('a cold caller proceeds after COLD_DEADLINE_MS while the read is still pending', async () => {
    let settle: (value: { policy: never; etag: string }) => void = () => {};
    vi.mocked(readPolicy).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const service = LimitsService.getInstance();
    let returned = false;
    const pending = service.ensureFresh().then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(COLD_DEADLINE_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(returned).toBe(true);
    // Fail-open while cold: no policy, flagged unavailable.
    expect(service.getSnapshot()).toMatchObject({
      policy: null,
      policyUnavailable: true,
    });
    // The read is not cancelled: when it settles, the next caller has it.
    settle({ policy, etag: '"e1"' });
    await vi.advanceTimersByTimeAsync(0);
    await service.ensureFresh();
    expect(service.getSnapshot().policy).toBe(policy);
  });

  it('a warm caller on TTL expiry is served last-known-good without waiting', async () => {
    vi.mocked(readPolicy).mockResolvedValueOnce({ policy, etag: '"e1"' });
    const service = LimitsService.getInstance();
    await service.ensureFresh();
    // Expire the TTL, then make the refresh hang forever.
    vi.setSystemTime(Date.now() + 61_000);
    vi.mocked(readPolicy).mockReturnValue(new Promise(() => {}));
    let returned = false;
    await service.ensureFresh().then(() => {
      returned = true;
    });
    expect(returned).toBe(true);
    expect(service.getSnapshot().policy).toBe(policy);
    expect(readPolicy).toHaveBeenCalledTimes(2);
  });

  it('after a failed COLD read, requests inside the cooldown do not hit storage again', async () => {
    vi.mocked(readPolicy).mockRejectedValue(new Error('storage down'));
    const service = LimitsService.getInstance();
    await service.ensureFresh();
    await service.ensureFresh();
    await service.ensureFresh();
    expect(readPolicy).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6_000);
    await service.ensureFresh();
    expect(readPolicy).toHaveBeenCalledTimes(2);
  });
});
