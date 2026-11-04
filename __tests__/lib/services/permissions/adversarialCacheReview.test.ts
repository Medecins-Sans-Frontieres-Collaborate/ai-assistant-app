import { PermissionCache } from '@/lib/services/permissions/PermissionCache';

import { memoryPermissionStorage } from '@/__tests__/helpers/memoryPermissionStorage';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const schema = z.array(z.string());
const policy = { maxAgeMs: 300_000 };

describe('permission cache adversarial regressions', () => {
  it('canonicalizes user and tenant IDs for lookups and cross-replica invalidation', async () => {
    const store = memoryPermissionStorage();
    const first = new PermissionCache(store.storage, ' TENANT ');
    const second = new PermissionCache(store.storage, 'tenant');
    const upper = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
    const loader = vi.fn().mockResolvedValue(['grant']);
    await first.resolve(` ${upper} `, 'groups', schema, loader, policy);
    expect(
      (
        await second.resolve(
          upper.toLowerCase(),
          'groups',
          schema,
          loader,
          policy,
        )
      ).value,
    ).toEqual(['grant']);
    expect(loader).toHaveBeenCalledTimes(1);
    await second.invalidate('admin', upper.toLowerCase());
    loader.mockResolvedValue([]);
    expect(
      (await first.resolve(upper, 'groups', schema, loader, policy)).value,
    ).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(
      [...store.records.keys()].filter((path) => path.includes('/users/')),
    ).toHaveLength(1);
  });

  it.each([
    ['invalid JSON', '{broken'],
    ['invalid schema', JSON.stringify({ version: 99 })],
    [
      'forged identity',
      JSON.stringify({
        version: 1,
        tenantId: 'other',
        userId: 'forged',
        generation: 'bad',
        snapshots: {},
      }),
    ],
    ['oversized payload', 'x'.repeat(2 * 1024 * 1024 + 1)],
  ])(
    'repairs a %s user record using metadata CAS without parsing its contents',
    async (_label, body) => {
      const store = memoryPermissionStorage();
      const first = new PermissionCache(store.storage, 'tenant');
      const second = new PermissionCache(store.storage, 'tenant');
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
      store.records.set(path, { body, etag: '"corrupt"' });
      await expect(
        second.resolve('user', 'groups', schema, async () => [], policy),
      ).rejects.toThrow();
      const downloadsBeforeRecovery = store.download.mock.calls.length;
      const outcome = await second.invalidate('admin', 'user');
      expect(store.download).toHaveBeenCalledTimes(downloadsBeforeRecovery);
      expect(store.getProperties).toHaveBeenCalledWith(path);
      expect(JSON.parse(store.records.get(path)!.body)).toEqual({
        version: 1,
        tenantId: 'tenant',
        userId: 'user',
        generation: outcome.generation,
        snapshots: {},
        invalidatedAt: outcome.invalidatedAt,
        invalidatedBy: 'admin',
      });
      expect(
        (await first.resolve('user', 'groups', schema, async () => [], policy))
          .value,
      ).toEqual([]);
    },
  );

  it('repairs a corrupt global record and rejects old snapshots on another replica', async () => {
    const store = memoryPermissionStorage();
    const first = new PermissionCache(store.storage, 'tenant');
    const second = new PermissionCache(store.storage, 'tenant');
    await first.resolve(
      'user',
      'groups',
      schema,
      async () => ['grant'],
      policy,
    );
    await first.invalidate('admin');
    await first.resolve(
      'user',
      'groups',
      schema,
      async () => ['grant'],
      policy,
    );
    const path = [...store.records.keys()].find((path) =>
      path.endsWith('/generation.json'),
    )!;
    store.records.set(path, { body: '{broken', etag: '"corrupt"' });
    await expect(
      second.resolve('user', 'groups', schema, async () => [], policy),
    ).rejects.toThrow();
    await second.invalidate('admin');
    expect(
      (await first.resolve('user', 'groups', schema, async () => [], policy))
        .value,
    ).toEqual([]);
  });

  it('retries metadata-CAS conflicts rather than overwriting a concurrent invalidation blindly', async () => {
    const store = memoryPermissionStorage();
    const first = new PermissionCache(store.storage, 'tenant');
    const second = new PermissionCache(store.storage, 'tenant');
    await first.resolve(
      'user',
      'groups',
      schema,
      async () => ['grant'],
      policy,
    );
    const getProperties = store.getProperties.getMockImplementation()!;
    store.getProperties.mockImplementationOnce(async (path) => {
      const earlier = await getProperties(path);
      await second.invalidate('other-admin', 'user');
      return earlier;
    });
    const result = await first.invalidate('admin', 'user');
    expect(store.getProperties).toHaveBeenCalledTimes(3);
    expect(store.upload).toHaveBeenCalledTimes(4);
    expect(result.generation).toBeTruthy();
    expect(
      (await second.resolve('user', 'groups', schema, async () => [], policy))
        .value,
    ).toEqual([]);
  });

  it('does not claim successful recovery or write blindly when metadata cannot be read', async () => {
    const store = memoryPermissionStorage();
    const cache = new PermissionCache(store.storage, 'tenant');
    store.getProperties.mockRejectedValueOnce(new Error('Storage down'));
    await expect(cache.invalidate('admin', 'user')).rejects.toThrow(
      'Storage down',
    );
    expect(store.upload).not.toHaveBeenCalled();
    store.getProperties.mockResolvedValueOnce({ etag: '' });
    await expect(cache.invalidate('admin', 'user')).rejects.toThrow(
      'missing its CAS ETag',
    );
    expect(store.upload).not.toHaveBeenCalled();
  });
});
