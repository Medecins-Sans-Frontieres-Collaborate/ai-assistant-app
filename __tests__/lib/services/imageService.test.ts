import {
  cacheImageBase64,
  fetchImageBase64FromMessageContent,
} from '@/lib/services/imageService';

import type { ImageMessageContent } from '@/types/chat';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IMAGE_CACHE_MAX_ENTRIES = 30;

function makeContent(url: string): ImageMessageContent {
  return { type: 'image_url', image_url: { url, detail: 'auto' } };
}

describe('imageService cache (LRU bounded)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    // Stub fetch so the cache-miss path doesn't make real network calls.
    // The miss path is an integration concern; we focus on cache semantics.
    originalFetch = global.fetch;
    global.fetch = vi.fn(
      async () =>
        ({
          json: async () => ({ base64Url: '' }),
        }) as unknown as Response,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the cached value for a previously-cached URL', async () => {
    const url = '/api/file/cached-hit.png';
    cacheImageBase64(url, 'data:image/png;base64,AAA');

    const result = await fetchImageBase64FromMessageContent(makeContent(url));

    expect(result).toBe('data:image/png;base64,AAA');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('evicts the oldest entry once the size cap is exceeded', async () => {
    // Fill the cache to exactly the cap with a known-oldest entry first.
    const oldestUrl = '/api/file/oldest.png';
    cacheImageBase64(oldestUrl, 'data:oldest');
    for (let i = 1; i < IMAGE_CACHE_MAX_ENTRIES; i++) {
      cacheImageBase64(`/api/file/img-${i}.png`, `data:img-${i}`);
    }

    // The cache is full. Adding one more should evict `oldestUrl`.
    cacheImageBase64('/api/file/newest.png', 'data:newest');

    // A miss on `oldestUrl` would call fetch; verify that behavior.
    await fetchImageBase64FromMessageContent(makeContent(oldestUrl));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/file/oldest.png?filetype=image',
    );

    // The newest entry should still be a hit.
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    const newest = await fetchImageBase64FromMessageContent(
      makeContent('/api/file/newest.png'),
    );
    expect(newest).toBe('data:newest');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('promotes touched entries so they survive subsequent evictions', async () => {
    const survivor = '/api/file/survivor.png';
    cacheImageBase64(survivor, 'data:survivor');
    for (let i = 1; i < IMAGE_CACHE_MAX_ENTRIES; i++) {
      cacheImageBase64(`/api/file/lru-${i}.png`, `data:lru-${i}`);
    }

    // Read survivor — this should bump it to the most-recent position.
    await fetchImageBase64FromMessageContent(makeContent(survivor));

    // Now insert one more; the entry that was second-oldest (lru-1) should
    // be evicted instead of survivor.
    cacheImageBase64('/api/file/freshest.png', 'data:freshest');

    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    const survivorResult = await fetchImageBase64FromMessageContent(
      makeContent(survivor),
    );
    expect(survivorResult).toBe('data:survivor');
    expect(global.fetch).not.toHaveBeenCalled();

    // And lru-1 should now be a miss.
    await fetchImageBase64FromMessageContent(
      makeContent('/api/file/lru-1.png'),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
