import { MetadataRoute } from 'next';

/**
 * Internal-only application: disallow all crawlers from indexing any path.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  };
}
