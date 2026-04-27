import { ImageMessageContent } from '@/types/chat';

/**
 * Soft byte ceiling for the in-memory image cache. Entries are evicted
 * (oldest-first) until total cached bytes fall back under this limit.
 *
 * String length is used as a proxy for byte size: a base64 data URL stores
 * roughly 1 byte per character (ASCII), and even worst-case multi-byte
 * sequences would only modestly underestimate. The base64 expansion factor
 * (~1.33×) is already baked into the stored string itself, so length is the
 * right thing to bound rather than the original image's binary size.
 *
 * Held in a `let` so tests can dial the cap down via `_setImageCacheMaxBytes`
 * without having to allocate hundreds of MB of strings to drive eviction.
 */
const DEFAULT_IMAGE_CACHE_MAX_BYTES = 200 * 1024 * 1024; // 200MB
let imageCacheMaxBytes = DEFAULT_IMAGE_CACHE_MAX_BYTES;

/**
 * Test-only: override the byte cap to drive eviction with small strings.
 * Pass `null` to restore the production default.
 */
export const _setImageCacheMaxBytes = (bytes: number | null): void => {
  imageCacheMaxBytes = bytes ?? DEFAULT_IMAGE_CACHE_MAX_BYTES;
};

// LRU-by-insertion-order cache. We rely on Map preserving insertion order:
// every read of a cached entry calls `touchRecency`, which deletes-then-
// reinserts the entry to bump it to the most-recent position. When the
// cumulative byte budget is exceeded, oldest entries are evicted until the
// budget is satisfied. This avoids the previous entry-count cap, which
// gave only an approximate memory bound and could be wildly off for
// caches dominated by unusually large or small images.
const imageCache = new Map<string, string>();
let imageCacheBytes = 0;

function evictOne(): void {
  const oldest = imageCache.keys().next().value;
  if (oldest === undefined) return;
  const value = imageCache.get(oldest);
  imageCache.delete(oldest);
  if (value !== undefined) {
    imageCacheBytes -= value.length;
    if (imageCacheBytes < 0) imageCacheBytes = 0;
  }
}

function touchRecency(url: string, value: string): void {
  const previous = imageCache.get(url);
  if (previous !== undefined) {
    imageCacheBytes -= previous.length;
    if (imageCacheBytes < 0) imageCacheBytes = 0;
  }
  imageCache.delete(url);
  imageCache.set(url, value);
  imageCacheBytes += value.length;

  // A single entry larger than the cap should still be served on a hit —
  // evict it on the *next* insertion rather than refusing to cache it now.
  // The loop terminates either when we're under budget or there's only one
  // entry left (which we keep so the just-inserted value survives).
  while (imageCacheBytes > imageCacheMaxBytes && imageCache.size > 1) {
    evictOne();
  }
}

/**
 * Test-only: drop all entries and reset the byte counter.
 */
export const _clearImageCache = (): void => {
  imageCache.clear();
  imageCacheBytes = 0;
};

/**
 * Test/debug helper: returns current cache occupancy. Not part of the
 * public hot path — exported so unit tests can assert eviction without
 * peeking into module-private state.
 */
export const _imageCacheStats = () => ({
  entries: imageCache.size,
  bytes: imageCacheBytes,
});

/**
 * Cache base64 image data to avoid re-fetching from server.
 */
export const cacheImageBase64 = (url: string, base64: string): void => {
  touchRecency(url, base64);
};

/**
 * Fetch image base64 from cache or server.
 * For images just uploaded, uses cached base64 to avoid unnecessary API calls.
 *
 * This client-side refetch exists because the chat handlers expect base64
 * data URLs in `image_url.url` when the request reaches `/api/chat`. A future
 * cleanup could resolve `/api/file/{id}` references server-side and drop this
 * step; doing so requires updating each model handler (Anthropic, Azure
 * OpenAI, AI Foundry) to accept reference URLs and call `getBlobBase64String`
 * during message preparation.
 */
export const fetchImageBase64FromMessageContent = async (
  image: ImageMessageContent,
): Promise<string> => {
  try {
    if (image?.image_url?.url) {
      // Check cache first (for recently uploaded images). Re-touch on hit
      // so frequently-used entries stay warm under the LRU bound.
      const cached = imageCache.get(image.image_url.url);
      if (cached) {
        touchRecency(image.image_url.url, cached);
        return cached;
      }

      // Fetch from server if not in cache (for loaded messages)
      const filename =
        image.image_url.url.split('/')[
          image.image_url.url.split('/').length - 1
        ];
      const page: Response = await fetch(
        `/api/file/${filename}?filetype=image`,
      );
      const resp = await page.json();

      // Cache the fetched data for future use
      if (resp.base64Url) {
        touchRecency(image.image_url.url, resp.base64Url);
      }

      return resp.base64Url;
    } else {
      console.warn(
        `Couldn't find url in message content: ${JSON.stringify(image)}`,
      );
      return '';
    }
  } catch (error) {
    console.error('Error fetching the image:', error);
    return '';
  }
};
