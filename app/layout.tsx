import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';

import 'katex/dist/katex.min.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'MSF AI Assistant',
  description: 'AI Assistant for MSF Staff - Internal Use Only',
  applicationName: 'MSF AI Assistant',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'MSF AI',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: '/icons/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#212121' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

/**
 * Root layout for the entire application
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  // Read theme from cookie (single source of truth)
                  var match = document.cookie.match(/ui-prefs=([^;]+)/);
                  var theme = 'dark'; // default

                  if (match) {
                    try {
                      var prefs = JSON.parse(decodeURIComponent(match[1]));
                      theme = prefs.theme || 'dark';
                    } catch (e) {
                      theme = 'dark';
                    }
                  }

                  // Determine if dark mode should be applied
                  var isDark = theme === 'dark' ||
                    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

                  if (isDark) {
                    document.documentElement.classList.add('dark');
                  } else {
                    document.documentElement.classList.remove('dark');
                  }

                  // Set RTL direction based on locale from URL path
                  var pathSegments = window.location.pathname.split('/').filter(Boolean);
                  var pathLocale = pathSegments[0] || 'en';
                  var rtlLocales = ['ar', 'he', 'fa', 'ur'];
                  var isRTL = rtlLocales.includes(pathLocale);
                  document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
                  document.documentElement.lang = pathLocale;
                } catch (e) {
                  // Fallback to dark on error
                  document.documentElement.classList.add('dark');
                }
              })();
            `,
          }}
        />
        {/* Chunk load error auto-recovery: reloads once after deploy-induced chunk failures */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var RELOAD_KEY = 'chunk_error_reload';

                function isChunkError(message) {
                  if (!message) return false;
                  var patterns = [
                    'ChunkLoadError',
                    'Loading chunk',
                    'Failed to fetch dynamically imported module',
                    'error loading dynamically imported module'
                  ];
                  for (var i = 0; i < patterns.length; i++) {
                    if (message.indexOf(patterns[i]) !== -1) return true;
                  }
                  return false;
                }

                function handleChunkError() {
                  try {
                    if (sessionStorage.getItem(RELOAD_KEY)) return;
                    sessionStorage.setItem(RELOAD_KEY, '1');
                    window.location.reload();
                  } catch (e) {}
                }

                window.addEventListener('error', function(e) {
                  if (isChunkError(e.message || (e.error && e.error.message))) {
                    handleChunkError();
                  }
                });

                window.addEventListener('unhandledrejection', function(e) {
                  var msg = e.reason && (e.reason.message || String(e.reason));
                  if (isChunkError(msg)) {
                    handleChunkError();
                  }
                });

                window.addEventListener('load', function() {
                  try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) {}
                });
              })();
            `,
          }}
        />
      </head>
      <body className={inter.className} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
