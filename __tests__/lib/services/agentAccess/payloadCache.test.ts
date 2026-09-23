import { PayloadCache } from '@/lib/services/agentAccess/payloadCache';

import { describe, expect, it, vi } from 'vitest';

describe('PayloadCache', () => {
  it('serves an immutable hit without calling the loader again', async () => {
    const cache = new PayloadCache(1024);
    const loader = vi.fn(async () => ({ value: 'a', bytes: 10 }));
    expect((await cache.getOrLoadImmutable('k', loader))?.value).toBe('a');
    expect((await cache.getOrLoadImmutable('k', loader))?.value).toBe('a');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight load between concurrent misses', async () => {
    const cache = new PayloadCache(1024);
    let resolve!: (v: { value: string; bytes: number }) => void;
    const loader = vi.fn(
      () =>
        new Promise<{ value: string; bytes: number }>((r) => {
          resolve = r;
        }),
    );
    const a = cache.getOrLoadImmutable('k', loader);
    const b = cache.getOrLoadImmutable('k', loader);
    resolve({ value: 'x', bytes: 1 });
    expect((await a)?.value).toBe('x');
    expect((await b)?.value).toBe('x');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('evicts least-recently-used entries past the byte budget', async () => {
    const cache = new PayloadCache(100);
    await cache.getOrLoadImmutable('a', async () => ({ value: 1, bytes: 40 }));
    await cache.getOrLoadImmutable('b', async () => ({ value: 2, bytes: 40 }));
    // Touch a so b becomes the oldest.
    await cache.getOrLoadImmutable('a', async () => ({ value: 9, bytes: 40 }));
    await cache.getOrLoadImmutable('c', async () => ({ value: 3, bytes: 40 }));
    expect(cache.peek('a')).not.toBeNull();
    expect(cache.peek('b')).toBeNull();
    expect(cache.peek('c')).not.toBeNull();
    expect(cache.bytes).toBeLessThanOrEqual(100);
  });

  it('serves but never retains a value larger than half the budget', async () => {
    const cache = new PayloadCache(100);
    const entry = await cache.getOrLoadImmutable('big', async () => ({
      value: 'huge',
      bytes: 80,
    }));
    expect(entry?.value).toBe('huge');
    expect(cache.peek('big')).toBeNull();
    expect(cache.bytes).toBe(0);
  });

  it('keeps the cached entry when a revalidating loader answers unchanged', async () => {
    const cache = new PayloadCache(1024);
    await cache.getOrLoad('d', async () => ({
      value: 'v1',
      bytes: 2,
      etag: '"e1"',
    }));
    const loader = vi.fn(async (cached: unknown) => {
      expect(cached).toMatchObject({ etag: '"e1"' });
      return 'unchanged' as const;
    });
    expect((await cache.getOrLoad('d', loader))?.value).toBe('v1');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('drops the entry when the loader reports the blob gone', async () => {
    const cache = new PayloadCache(1024);
    await cache.getOrLoad('d', async () => ({ value: 'v1', bytes: 2 }));
    expect(await cache.getOrLoad('d', async () => null)).toBeNull();
    expect(cache.peek('d')).toBeNull();
  });

  it('does not cache loader failures', async () => {
    const cache = new PayloadCache(1024);
    await expect(
      cache.getOrLoadImmutable('f', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const loader = vi.fn(async () => ({ value: 'ok', bytes: 1 }));
    expect((await cache.getOrLoadImmutable('f', loader))?.value).toBe('ok');
  });

  it('deletes by prefix', async () => {
    const cache = new PayloadCache(1024);
    await cache.getOrLoadImmutable('p/1', async () => ({ value: 1, bytes: 1 }));
    await cache.getOrLoadImmutable('p/2', async () => ({ value: 2, bytes: 1 }));
    await cache.getOrLoadImmutable('q/1', async () => ({ value: 3, bytes: 1 }));
    cache.deleteByPrefix('p/');
    expect(cache.peek('p/1')).toBeNull();
    expect(cache.peek('p/2')).toBeNull();
    expect(cache.peek('q/1')).not.toBeNull();
  });
});
