import {
  PermissionCache,
  PermissionCacheInvalidatedError,
} from '@/lib/services/permissions/PermissionCache';

import { memoryPermissionStorage } from '@/__tests__/helpers/memoryPermissionStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const schema = z.array(z.string());
const policy = { maxAgeMs: 5 * 60_000 };
const store = memoryPermissionStorage();
let first: PermissionCache;
let second: PermissionCache;

beforeEach(() => {
  store.records.clear();
  vi.clearAllMocks();
  first = new PermissionCache(store.storage, 'tenant');
  second = new PermissionCache(store.storage, 'tenant');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('shared permission snapshots', () => {
  it('reuses a snapshot across replicas and keeps the original hard expiration', async () => {
    const loader = vi.fn().mockResolvedValue(['group']);
    const initial = await first.resolve(
      'user',
      'groups',
      schema,
      loader,
      policy,
    );
    vi.advanceTimersByTime(policy.maxAgeMs - 1);
    const reused = await second.resolve(
      'user',
      'groups',
      schema,
      loader,
      policy,
    );
    expect(reused.expiresAt).toBe(initial.expiresAt);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    loader.mockResolvedValue([]);
    expect(
      (await second.resolve('user', 'groups', schema, loader, policy)).value,
    ).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('revalidates memory hits and respects a tightened maximum age', async () => {
    const loader = vi.fn().mockResolvedValue(['group']);
    await first.resolve('user', 'groups', schema, loader, policy);
    const reads = store.download.mock.calls.length;
    await first.resolve('user', 'groups', schema, loader, policy);
    expect(store.download.mock.calls.length).toBe(reads + 2);
    vi.advanceTimersByTime(60_000);
    await first.resolve('user', 'groups', schema, loader, { maxAgeMs: 60_000 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('isolates tenants, users and resource revisions', async () => {
    const loader = vi.fn().mockResolvedValue(['group']);
    const otherTenant = new PermissionCache(store.storage, 'other-tenant');
    await first.resolve('user', 'groups', schema, loader, policy);
    await first.resolve('other-user', 'groups', schema, loader, policy);
    await otherTenant.resolve('user', 'groups', schema, loader, policy);
    await first.resolve('user', 'source:revision-1', schema, loader, policy);
    await first.resolve('user', 'source:revision-2', schema, loader, policy);
    expect(loader).toHaveBeenCalledTimes(5);
  });

  it('invalidates only the selected user across warm replicas', async () => {
    const loader = vi.fn().mockResolvedValue(['old']);
    await first.resolve('user', 'groups', schema, loader, policy);
    await second.resolve('user', 'groups', schema, loader, policy);
    await second.resolve('other', 'groups', schema, loader, policy);
    await first.invalidate('admin', 'user');
    loader.mockResolvedValue(['new']);
    expect(
      (await second.resolve('user', 'groups', schema, loader, policy)).value,
    ).toEqual(['new']);
    expect(
      (await second.resolve('other', 'groups', schema, loader, policy)).value,
    ).toEqual(['old']);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('global invalidation rejects every old membership and source snapshot', async () => {
    const loader = vi.fn().mockResolvedValue(['old']);
    await first.resolve('one', 'groups', schema, loader, policy);
    await second.resolve('two', 'source', schema, loader, policy);
    await first.invalidate('admin');
    loader.mockResolvedValue([]);
    expect(
      (await second.resolve('one', 'groups', schema, loader, policy)).value,
    ).toEqual([]);
    expect(
      (await second.resolve('two', 'source', schema, loader, policy)).value,
    ).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it.each(['user', undefined])(
    'fences an in-flight refresh during %s invalidation',
    async (target) => {
      let release!: (value: string[]) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const work = second.resolve(
        'user',
        'groups',
        schema,
        () => {
          started();
          return new Promise<string[]>((resolve) => {
            release = resolve;
          });
        },
        policy,
      );
      await ready;
      await first.invalidate('admin', target);
      const assertion = expect(work).rejects.toBeInstanceOf(
        PermissionCacheInvalidatedError,
      );
      release(['stale']);
      await assertion;
      expect(
        (await second.resolve('user', 'groups', schema, async () => [], policy))
          .value,
      ).toEqual([]);
    },
  );

  it('single-flights concurrent lookups and merges independent resource refreshes', async () => {
    const loader = vi.fn().mockResolvedValue(['group']);
    await Promise.all([
      first.resolve('user', 'groups', schema, loader, policy),
      first.resolve('user', 'groups', schema, loader, policy),
      second.resolve('user', 'source', schema, async () => ['file'], policy),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(
      (await second.resolve('user', 'groups', schema, loader, policy)).value,
    ).toEqual(['group']);
    expect(
      (await first.resolve('user', 'source', schema, loader, policy)).value,
    ).toEqual(['file']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])(
    'does not overwrite a newer result with a slower older refresh (%s ms between starts)',
    async (delay) => {
      let release!: (value: string[]) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const slow = first.resolve(
        'user',
        'groups',
        schema,
        () => {
          started();
          return new Promise<string[]>((resolve) => {
            release = resolve;
          });
        },
        policy,
      );
      await ready;
      vi.advanceTimersByTime(delay);
      await second.resolve(
        'user',
        'groups',
        schema,
        async () => ['new'],
        policy,
      );
      release(['old']);
      expect((await slow).value).toEqual(['new']);
    },
  );

  it('does not serve stale grants after expiry or a storage outage', async () => {
    await first.resolve(
      'user',
      'groups',
      schema,
      async () => ['grant'],
      policy,
    );
    vi.advanceTimersByTime(policy.maxAgeMs);
    await expect(
      first.resolve(
        'user',
        'groups',
        schema,
        async () => {
          throw new Error('Graph down');
        },
        policy,
      ),
    ).rejects.toThrow('Graph down');
    store.download.mockRejectedValueOnce(new Error('Storage down'));
    await expect(
      first.resolve('user', 'groups', schema, async () => ['grant'], policy),
    ).rejects.toThrow('Storage down');
  });

  it('keeps failure cooldowns local and invalidation bypasses them', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('Graph down'));
    const failurePolicy = { ...policy, failureTtlMs: () => 60_000 };
    await expect(
      second.resolve('user', 'groups', schema, loader, failurePolicy),
    ).rejects.toThrow();
    await expect(
      second.resolve('user', 'groups', schema, loader, failurePolicy),
    ).rejects.toThrow();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(
      [...store.records.keys()].filter((path) => path.includes('/users/')),
    ).toHaveLength(0);
    await first.invalidate('admin', 'user');
    loader.mockResolvedValue([]);
    expect(
      (await second.resolve('user', 'groups', schema, loader, failurePolicy))
        .value,
    ).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it.each(['user', undefined])(
    'fences %s invalidation after snapshot publication but before authorization',
    async (target) => {
      const upload = store.upload.getMockImplementation()!;
      store.upload.mockImplementationOnce(async (...args) => {
        const result = await upload(...args);
        await first.invalidate('admin', target);
        return result;
      });
      await expect(
        second.resolve('user', 'groups', schema, async () => ['old'], policy),
      ).rejects.toBeInstanceOf(PermissionCacheInvalidatedError);
      expect(
        (await second.resolve('user', 'groups', schema, async () => [], policy))
          .value,
      ).toEqual([]);
    },
  );

  it('does not grant from a snapshot that expires during final generation validation', async () => {
    const download = store.download.getMockImplementation()!;
    let reads = 0;
    store.download.mockImplementation(async (...args) => {
      if (++reads === 5) vi.advanceTimersByTime(1);
      return download(...args);
    });
    try {
      await expect(
        first.resolve(
          'user',
          'groups',
          schema,
          async () => {
            vi.advanceTimersByTime(policy.maxAgeMs - 1);
            return ['grant'];
          },
          policy,
        ),
      ).rejects.toThrow('expired during verification');
    } finally {
      store.download.mockImplementation(download);
    }
  });

  it('caller mutation cannot change another replica-local cached permission value', async () => {
    const initial = await first.resolve(
      'user',
      'groups',
      schema,
      async () => ['grant'],
      policy,
    );
    initial.value.push('forged');
    expect(
      (await first.resolve('user', 'groups', schema, async () => [], policy))
        .value,
    ).toEqual(['grant']);
  });

  it('rejects malformed snapshots rather than treating them as an empty permission set', async () => {
    await first.resolve(
      'user',
      'groups',
      schema,
      async () => ['grant'],
      policy,
    );
    const path = [...store.records.keys()].find((path) =>
      path.includes('/users/'),
    )!;
    store.records.set(path, { body: '{invalid', etag: '"broken"' });
    await expect(
      second.resolve('user', 'groups', schema, async () => [], policy),
    ).rejects.toThrow();
  });
});
