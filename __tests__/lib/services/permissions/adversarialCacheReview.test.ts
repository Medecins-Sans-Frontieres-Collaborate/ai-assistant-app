import { PermissionCache } from '@/lib/services/permissions/PermissionCache';

import { memoryPermissionStorage } from '@/__tests__/helpers/memoryPermissionStorage';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('adversarial cache review reproductions', () => {
  it('reproduces an invalidation miss for differently cased Entra object IDs', async () => {
    const store = memoryPermissionStorage();
    const cache = new PermissionCache(store.storage, 'tenant');
    const upper = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
    const loader = vi.fn().mockResolvedValue(['grant']);
    const policy = { maxAgeMs: 300_000 };
    const schema = z.array(z.string());
    await cache.resolve(upper, 'groups', schema, loader, policy);
    await cache.invalidate('admin', upper.toLowerCase());
    loader.mockResolvedValue([]);
    const result = await cache.resolve(upper, 'groups', schema, loader, policy);
    expect(result.value).toEqual(['grant']);
    expect(loader).toHaveBeenCalledTimes(1);
    console.log(
      'CONFIRMED: lowercase invalidation leaves uppercase object-ID grants usable',
    );
  });

  it('reproduces inability to repair a corrupt user record via manual invalidation', async () => {
    const store = memoryPermissionStorage();
    const cache = new PermissionCache(store.storage, 'tenant');
    await cache.resolve(
      'user',
      'groups',
      z.array(z.string()),
      async () => ['grant'],
      { maxAgeMs: 300_000 },
    );
    const path = [...store.records.keys()].find((path) =>
      path.includes('/users/'),
    )!;
    store.records.set(path, { body: '{broken', etag: '"corrupt"' });
    await expect(cache.invalidate('admin', 'user')).rejects.toThrow();
    expect(store.records.get(path)?.body).toBe('{broken');
    console.log(
      'CONFIRMED: corrupt cached payload also blocks the manual recovery action',
    );
  });
});
