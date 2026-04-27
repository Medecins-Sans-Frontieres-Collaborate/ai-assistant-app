import { ImageMessageContent } from '@/types/chat';

/**
 * Maximum entries kept in the in-memory image cache. Each entry stores a
 * full base64 data URL, which is roughly 1.33× the original image bytes
 * (5MB image → ~6.7MB string). With the 5MB image cap, 30 entries is
 * ~200MB worst case — high enough that typical sessions never evict, but
 * bounded so a long session full of unique images can't grow tab memory
 * unbounded.
 */
const IMAGE_CACHE_MAX_ENTRIES = 30;

// LRU-by-insertion-order cache for image base64 data. We rely on Map
// preserving insertion order: re-inserting on read moves the entry to the
// most-recent position; the oldest entry is evicted first when full.
const imageCache = new Map<string, string>();

function touchRecency(url: string, value: string): void {
  imageCache.delete(url);
  imageCache.set(url, value);
  while (imageCache.size > IMAGE_CACHE_MAX_ENTRIES) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
}

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
