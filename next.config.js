const createNextIntlPlugin = require('next-intl/plugin');
const withNextIntl = createNextIntlPlugin('./i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['streamdown', 'shiki', 'mermaid'],

  // Disable Next.js built-in gzip compression — it buffers chunks into
  // compression blocks, which breaks fine-grained streaming.  Compression
  // should be handled by the upstream reverse proxy / CDN instead.
  compress: false,

  // Experimental settings for large file uploads
  // Supports up to 1.5GB video files + buffer for form data overhead
  experimental: {
    serverActions: {
      bodySizeLimit: '1600mb',
    },
    proxyClientMaxBodySize: '1600mb',
    // Tree-shake big icon / utility packages so unused exports don't bloat
    // the first-load JS bundle. @tabler/icons-react has 108+ import sites
    // and re-exports thousands of icons; without this every page pulls the
    // full registry. Verified safe for these packages — they use named
    // exports throughout.
    optimizePackageImports: ['@tabler/icons-react', '@tanstack/react-query'],
  },

  // Remove X-Powered-By header for security
  poweredByHeader: false,

  generateBuildId: async () => {
    return (
      process.env.GITHUB_SHA ||
      process.env.BUILD_ID ||
      new Date().getTime().toString()
    );
  },

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.google.com',
      },
    ],
  },

  // Redirect old NextAuth v4 routes to current paths
  redirects: async () => {
    return [
      // Old v4 callback provider name → new v5 provider name
      {
        source: '/api/auth/callback/azure-ad',
        destination: '/api/auth/callback/microsoft-entra-id',
        permanent: true,
      },
      // Old v4 built-in signin page → custom signin page
      {
        source: '/auth/signin',
        destination: '/signin',
        permanent: true,
      },
    ];
  },

  rewrites: async () => {
    return [
      {
        source: '/healthz',
        destination: '/api/health',
      },
    ];
  },

  // Security & caching headers
  headers: async () => {
    const isProd = process.env.NODE_ENV === 'production';
    return [
      // Overriding cache headers on /_next/static/* breaks Turbopack HMR in
      // dev (module-factory load errors), so only set this in prod.
      ...(isProd
        ? [
            {
              source: '/_next/static/(.*)',
              headers: [
                {
                  key: 'Cache-Control',
                  value: 'public, max-age=31536000, immutable',
                },
              ],
            },
          ]
        : []),
      {
        source: '/((?!_next|api|icons|favicon).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
        ],
      },
      // Disable proxy buffering for the streaming chat endpoint (defense-in-depth)
      {
        source: '/api/chat',
        headers: [{ key: 'X-Accel-Buffering', value: 'no' }],
      },
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://login.microsoftonline.com https://cdn.jsdelivr.net; " +
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
              "img-src 'self' data: https: blob:; " +
              "font-src 'self' data:; " +
              "connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.ai.msfusa.org https://*.launchdarkly.com; " +
              "media-src 'self' blob:; " +
              "worker-src 'self' blob:; " +
              "frame-src 'self'; " +
              "frame-ancestors 'none';",
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },

  webpack(config, { isServer, dev }) {
    config.experiments = {
      asyncWebAssembly: true,
      layers: true,
    };

    // Copy Monaco Editor files to public directory
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        'monaco-editor': require.resolve('monaco-editor'),
      };
    }

    return config;
  },
};

module.exports = withNextIntl(nextConfig);
