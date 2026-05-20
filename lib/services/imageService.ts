import { ImageMessageContent } from '@/types/chat';

// In-memory cache for image base64 data to avoid re-fetching from server
const imageCache = new Map<string, string>();

/**
 * Cache base64 image data to avoid re-fetching from server
 */
export const cacheImageBase64 = (url: string, base64: string): void => {
  imageCache.set(url, base64);
};

/**
 * Fetch image base64 from cache or server
 * For images just uploaded, uses cached base64 to avoid unnecessary API calls
 */
export const fetchImageBase64FromMessageContent = async (
  image: ImageMessageContent,
): Promise<string> => {
  try {
    if (image?.image_url?.url) {
      // Check cache first (for recently uploaded images)
      const cached = imageCache.get(image.image_url.url);
      if (cached) {
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
        imageCache.set(image.image_url.url, resp.base64Url);
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
