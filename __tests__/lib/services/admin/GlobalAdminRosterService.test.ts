import {
  COLD_DEADLINE_MS,
  GlobalAdminRosterService,
} from '@/lib/services/admin/GlobalAdminRosterService';
import {
  __resetGlobalAdminSnapshotForTests,
  isConfigGlobalAdmin,
  isGlobalAdminSnapshotLoaded,
} from '@/lib/services/admin/globalAdminsSnapshot';
import {
  createGlobalAdminsBlobStorage,
  readGlobalAdmins,
} from '@/lib/services/admin/globalAdminsStore';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/admin/globalAdminsStore', () => ({
  createGlobalAdminsBlobStorage: vi.fn(),
  readGlobalAdmins: vi.fn(),
}));

const roster = {
  version: 1 as const,
  admins: ['config@example.com'],
  updatedBy: 'env@example.com',
  updatedAt: '2026-09-04T00:00:00.000Z',
};

describe('admin/GlobalAdminRosterService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    GlobalAdminRosterService.resetInstance();
    __resetGlobalAdminSnapshotForTests();
    vi.mocked(createGlobalAdminsBlobStorage).mockReturnValue({} as never);
    vi.mocked(readGlobalAdmins).mockResolvedValue({ roster, etag: '"e1"' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes the roster into the sync snapshot on a successful read', async () => {
    const service = GlobalAdminRosterService.getInstance();
    await service.ensureFresh();

    expect(isGlobalAdminSnapshotLoaded()).toBe(true);
    expect(isConfigGlobalAdmin('config@example.com')).toBe(true);
    expect(service.getSnapshot()).toEqual({
      roster,
      etag: '"e1"',
      rosterUnavailable: false,
      fetchedAt: Date.now(),
    });
  });

  it('treats a missing blob as a loaded, empty roster (env admins only)', async () => {
    vi.mocked(readGlobalAdmins).mockResolvedValue(null);
    const service = GlobalAdminRosterService.getInstance();
    await service.ensureFresh();

    expect(service.getSnapshot()).toMatchObject({
      roster: null,
      etag: null,
      rosterUnavailable: false,
    });
    expect(isGlobalAdminSnapshotLoaded()).toBe(true);
    expect(isConfigGlobalAdmin('config@example.com')).toBe(false);
  });

  it('is a no-op while the 60s TTL is warm and refetches after it', async () => {
    const service = GlobalAdminRosterService.getInstance();
    await service.ensureFresh();
    vi.advanceTimersByTime(59_000);
    await service.ensureFresh();
    expect(readGlobalAdmins).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await service.ensureFresh();
    expect(readGlobalAdmins).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent ensureFresh() calls', async () => {
    const service = GlobalAdminRosterService.getInstance();
    await Promise.all([service.ensureFresh(), service.ensureFresh()]);

    expect(readGlobalAdmins).toHaveBeenCalledTimes(1);
  });

  describe('failure posture', () => {
    it('never throws, and cold + failed leaves the snapshot cold (env roster only)', async () => {
      vi.mocked(readGlobalAdmins).mockRejectedValue(new Error('storage down'));
      const service = GlobalAdminRosterService.getInstance();

      await expect(service.ensureFresh()).resolves.toBeUndefined();

      expect(service.getSnapshot()).toEqual({
        roster: null,
        etag: null,
        rosterUnavailable: true,
        fetchedAt: null,
      });
      expect(isGlobalAdminSnapshotLoaded()).toBe(false);
      expect(isConfigGlobalAdmin('config@example.com')).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('env roster only'),
      );
    });

    it('applies the failure cooldown EVEN ON COLD START (deviation from LimitsService)', async () => {
      // The warm-up runs inside the auth() session callback on every request;
      // without a cold cooldown a storage outage would tax every request with
      // full retry latency. Cold + failed = env-only, which is safe.
      vi.mocked(readGlobalAdmins).mockRejectedValue(new Error('storage down'));
      const service = GlobalAdminRosterService.getInstance();

      await service.ensureFresh();
      await service.ensureFresh();
      vi.advanceTimersByTime(4_000);
      await service.ensureFresh();
      expect(readGlobalAdmins).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_500);
      await service.ensureFresh();
      expect(readGlobalAdmins).toHaveBeenCalledTimes(2);
    });

    it('a synchronously throwing storage factory (unconfigured account) is swallowed', async () => {
      // createAdminBlobStorage() throws when no account is configured; local
      // dev without storage must still be able to sign in.
      vi.mocked(createGlobalAdminsBlobStorage).mockImplementation(() => {
        throw new Error('Admin storage requires a storage account');
      });
      const service = GlobalAdminRosterService.getInstance();

      await expect(service.ensureFresh()).resolves.toBeUndefined();
      expect(service.getSnapshot().rosterUnavailable).toBe(true);
      expect(readGlobalAdmins).not.toHaveBeenCalled();
    });

    it('keeps the last-known-good roster and snapshot when a later refresh fails', async () => {
      const service = GlobalAdminRosterService.getInstance();
      await service.ensureFresh();

      vi.advanceTimersByTime(61_000);
      vi.mocked(readGlobalAdmins).mockRejectedValue(new Error('storage down'));
      await service.ensureFresh();
      // The refresh runs in the background once a roster is loaded.
      await vi.advanceTimersByTimeAsync(0);

      expect(service.getSnapshot()).toMatchObject({
        roster,
        etag: '"e1"',
        rosterUnavailable: false,
      });
      expect(isConfigGlobalAdmin('config@example.com')).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('last-known-good'),
      );
    });
  });

  /**
   * Contract: ensureFresh() runs inside the auth() session callback on every
   * request, and the read chain beneath it has no client-side deadline. So a
   * STALLED (never-settling) storage read must never park callers: a loaded
   * replica serves last-known-good and revalidates in the background; a cold
   * replica waits at most COLD_DEADLINE_MS, then degrades to env-only for that
   * request while the read continues and publishes whenever it settles.
   */
  describe('bounded wait on a stalled read', () => {
    type ReadResult = Awaited<ReturnType<typeof readGlobalAdmins>>;

    function stallNextRead(): (value: ReadResult) => void {
      let resolveRead: (value: ReadResult) => void = () => {};
      vi.mocked(readGlobalAdmins).mockImplementationOnce(
        () =>
          new Promise<ReadResult>((resolve) => {
            resolveRead = resolve;
          }),
      );
      return (value) => resolveRead(value);
    }

    function track(promise: Promise<void>): { settled: boolean } {
      const state = { settled: false };
      void promise.then(() => {
        state.settled = true;
      });
      return state;
    }

    it('loaded + stale: returns immediately with last-known-good while the read stalls', async () => {
      const service = GlobalAdminRosterService.getInstance();
      await service.ensureFresh();
      vi.advanceTimersByTime(61_000);
      stallNextRead();

      const call = track(service.ensureFresh());
      // No timer advance at all: a warm replica never waits on storage.
      await vi.advanceTimersByTimeAsync(0);

      expect(call.settled).toBe(true);
      expect(readGlobalAdmins).toHaveBeenCalledTimes(2);
      expect(service.getSnapshot()).toMatchObject({
        roster,
        etag: '"e1"',
        rosterUnavailable: false,
      });
      expect(isConfigGlobalAdmin('config@example.com')).toBe(true);

      // Ten minutes of stall later, callers are still not parked and no
      // second read has been started behind the stalled one.
      const later = track(service.ensureFresh());
      await vi.advanceTimersByTimeAsync(600_000);
      expect(later.settled).toBe(true);
      expect(readGlobalAdmins).toHaveBeenCalledTimes(2);
    });

    it('cold: settles at COLD_DEADLINE_MS as env-only (rosterUnavailable) while the read stalls', async () => {
      stallNextRead();
      const service = GlobalAdminRosterService.getInstance();

      const call = track(service.ensureFresh());
      await vi.advanceTimersByTimeAsync(COLD_DEADLINE_MS - 1);
      expect(call.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(call.settled).toBe(true);
      expect(service.getSnapshot()).toEqual({
        roster: null,
        etag: null,
        rosterUnavailable: true,
        fetchedAt: null,
      });
      expect(isGlobalAdminSnapshotLoaded()).toBe(false);
      expect(isConfigGlobalAdmin('config@example.com')).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('serving env roster only'),
      );
      // A stall is not a failure: no cooldown was stamped, nothing was logged
      // as an error.
      expect(console.error).not.toHaveBeenCalled();
    });

    it('cold: a later resolve of the stalled read publishes the snapshot for subsequent callers', async () => {
      const resolveRead = stallNextRead();
      const service = GlobalAdminRosterService.getInstance();
      await Promise.all([
        service.ensureFresh(),
        vi.advanceTimersByTimeAsync(COLD_DEADLINE_MS),
      ]);
      expect(service.getSnapshot().rosterUnavailable).toBe(true);

      vi.advanceTimersByTime(30_000);
      resolveRead({ roster, etag: '"late"' });
      await vi.advanceTimersByTimeAsync(0);

      expect(service.getSnapshot()).toEqual({
        roster,
        etag: '"late"',
        rosterUnavailable: false,
        fetchedAt: Date.now(),
      });
      expect(isConfigGlobalAdmin('config@example.com')).toBe(true);

      // Freshness was stamped when the read landed, so the next caller is a
      // warm no-op rather than a new read.
      await service.ensureFresh();
      expect(readGlobalAdmins).toHaveBeenCalledTimes(1);
    });

    it('cold: callers arriving after the deadline re-await the SAME stalled read (single-flight) and each get their own bounded wait', async () => {
      const resolveRead = stallNextRead();
      const service = GlobalAdminRosterService.getInstance();

      const first = track(service.ensureFresh());
      await vi.advanceTimersByTimeAsync(COLD_DEADLINE_MS);
      expect(first.settled).toBe(true);

      const second = track(service.ensureFresh());
      const third = track(service.ensureFresh());
      await vi.advanceTimersByTimeAsync(COLD_DEADLINE_MS - 1);
      expect(second.settled).toBe(false);
      expect(third.settled).toBe(false);
      expect(readGlobalAdmins).toHaveBeenCalledTimes(1);

      // The read lands just before the second deadline: both callers see it.
      resolveRead({ roster, etag: '"e1"' });
      await vi.advanceTimersByTimeAsync(0);
      expect(second.settled).toBe(true);
      expect(third.settled).toBe(true);
      expect(service.getSnapshot().rosterUnavailable).toBe(false);
      expect(readGlobalAdmins).toHaveBeenCalledTimes(1);
      // Only one stall warning per stalled read, not one per parked request.
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('cold: a read that resolves before the deadline settles the caller at once', async () => {
      const resolveRead = stallNextRead();
      const service = GlobalAdminRosterService.getInstance();

      const call = track(service.ensureFresh());
      await vi.advanceTimersByTimeAsync(100);
      resolveRead({ roster, etag: '"e1"' });
      await vi.advanceTimersByTimeAsync(0);

      expect(call.settled).toBe(true);
      expect(service.getSnapshot().rosterUnavailable).toBe(false);
      expect(console.warn).not.toHaveBeenCalled();
      // The deadline timer was cleared: nothing fires later.
      await vi.advanceTimersByTimeAsync(COLD_DEADLINE_MS);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  it('invalidate() forces the next ensureFresh() to refetch and clears the cooldown', async () => {
    vi.mocked(readGlobalAdmins).mockRejectedValueOnce(
      new Error('storage down'),
    );
    const service = GlobalAdminRosterService.getInstance();
    await service.ensureFresh();
    expect(readGlobalAdmins).toHaveBeenCalledTimes(1);

    // Still inside the 5s cooldown — invalidate lifts it (an admin write on
    // this replica must be visible promptly).
    service.invalidate();
    await service.ensureFresh();
    expect(readGlobalAdmins).toHaveBeenCalledTimes(2);
    expect(isConfigGlobalAdmin('config@example.com')).toBe(true);

    service.invalidate();
    await service.ensureFresh();
    expect(readGlobalAdmins).toHaveBeenCalledTimes(3);
  });

  it('a refresh that was in flight when invalidate() landed does not stamp freshness', async () => {
    let resolveRead: (value: {
      roster: typeof roster;
      etag: string;
    }) => void = () => {};
    vi.mocked(readGlobalAdmins).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const service = GlobalAdminRosterService.getInstance();
    const pending = service.ensureFresh();
    service.invalidate();
    resolveRead({ roster, etag: '"stale"' });
    await pending;

    // Loaded (data is served), but the next ensureFresh refetches at once.
    expect(service.getSnapshot().rosterUnavailable).toBe(false);
    await service.ensureFresh();
    expect(readGlobalAdmins).toHaveBeenCalledTimes(2);
  });
});
