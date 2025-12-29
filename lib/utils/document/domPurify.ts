/**
 * Dynamically load DOMPurify (works on both client and server).
 * Uses isomorphic-dompurify which handles SSR via jsdom.
 *
 * Dynamic import avoids Next.js bundler path resolution issues
 * that occur with top-level imports of isomorphic-dompurify.
 *
 * Uses closure to cache the Promise without module-level mutable state.
 *
 * @returns Promise resolving to DOMPurify instance with sanitize method
 */
export const getDOMPurify = (() => {
  let cached: Promise<{
    sanitize: (dirty: string, config?: object) => string;
  }> | null = null;

  return () => {
    if (!cached) {
      cached = import('isomorphic-dompurify').then(
        (m) =>
          m.default as { sanitize: (dirty: string, config?: object) => string },
      );
    }
    return cached;
  };
})();
