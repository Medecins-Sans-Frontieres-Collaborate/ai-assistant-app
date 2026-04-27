import {
  _clearImageCache,
  _imageCacheStats,
  _setImageCacheMaxBytes,
  cacheImageBase64,
  fetchImageBase64FromMessageContent,
} from '@/lib/services/imageService';

import type { ImageMessageContent } from '@/types/chat';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeContent(url: string): ImageMessageContent {
  return { type: 'image_url', image_url: { url, detail: 'auto' } };
}

const TEST_CAP_BYTES = 1_000;

describe('imageService cache (LRU bounded by bytes)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    // Stub fetch so the cache-miss path doesn't make real network calls.
    originalFetch = global.fetch;
    global.fetch = vi.fn(
      async () =>
        ({
          json: async () => ({ base64Url: '' }),
        }) as unknown as Response,
    );
    _clearImageCache();
    _setImageCacheMaxBytes(TEST_CAP_BYTES);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    _clearImageCache();
    _setImageCacheMaxBytes(null);
  });

  it('returns the cached value for a previously-cached URL', async () => {
    const url = '/api/file/cached-hit.png';
    cacheImageBase64(url, 'data:image/png;base64,AAA');

    const result = await fetchImageBase64FromMessageContent(makeContent(url));

    expect(result).toBe('data:image/png;base64,AAA');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('tracks cumulative byte size, not entry count', () => {
    cacheImageBase64('/a', 'x'.repeat(300));
    cacheImageBase64('/b', 'x'.repeat(300));

    const stats = _imageCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBe(600);
  });

  it('evicts oldest entries until total bytes are back under the cap', () => {
    // Three 400-byte entries = 1200 bytes total, exceeds the 1000-byte cap.
    // Eviction should drop the oldest (/a) so the remaining two fit.
    cacheImageBase64('/a', 'x'.repeat(400));
    cacheImageBase64('/b', 'x'.repeat(400));
    cacheImageBase64('/c', 'x'.repeat(400));

    const stats = _imageCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(TEST_CAP_BYTES);
    expect(stats.entries).toBe(2);
  });

  it('evicts oldest entry on cache miss when fetch result pushes over cap', async () => {
    const oldestUrl = '/api/file/oldest.png';
    cacheImageBase64(oldestUrl, 'x'.repeat(700));
    cacheImageBase64('/api/file/middle.png', 'x'.repeat(200));

    // Adding 200 more bytes (total 1100) exceeds the 1000-byte cap → oldest evicted.
    cacheImageBase64('/api/file/newest.png', 'x'.repeat(200));

    // A miss on `oldestUrl` should now fall through to fetch.
    await fetchImageBase64FromMessageContent(makeContent(oldestUrl));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/file/oldest.png?filetype=image',
    );
  });

  it('promotes touched entries so they survive subsequent evictions', async () => {
    const survivor = '/api/file/survivor.png';
    cacheImageBase64(survivor, 'x'.repeat(400));
    cacheImageBase64('/api/file/middle.png', 'x'.repeat(400));

    // Read survivor — bumps it to the most-recent position.
    await fetchImageBase64FromMessageContent(makeContent(survivor));

    // Insert another 400-byte entry; cumulative would be 1200 > 1000, so the
    // entry that's now oldest (`middle.png`) should be evicted instead of survivor.
    cacheImageBase64('/api/file/freshest.png', 'x'.repeat(400));

    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    const survivorResult = await fetchImageBase64FromMessageContent(
      makeContent(survivor),
    );
    expect(survivorResult).toBe('x'.repeat(400));
    expect(global.fetch).not.toHaveBeenCalled();

    await fetchImageBase64FromMessageContent(
      makeContent('/api/file/middle.png'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/file/middle.png?filetype=image',
    );
  });

  it('keeps an oversized single entry rather than refusing to cache it', () => {
    // A single 5000-byte string exceeds the 1000-byte cap, but the cache
    // still stores it (eviction loop terminates at size === 1) so a
    // legitimate cache hit on it can still be served.
    cacheImageBase64('/big', 'x'.repeat(5_000));
    const stats = _imageCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(5_000);
  });
});
