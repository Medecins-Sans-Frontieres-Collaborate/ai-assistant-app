import { GlobalAdminRosterService } from '@/lib/services/admin/GlobalAdminRosterService';
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
