'use client';

import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useEffect } from 'react';

import { FEEDBACK_EMAIL } from '@/types/contact';

/**
 * Global error boundary for the entire application.
 * Uses hardcoded English strings since this runs outside of providers.
 * This is intentional - global errors are rare catastrophic failures,
 * and simpler code = more reliable error recovery.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-white dark:bg-surface-dark">
        {/* Simple hardcoded error UI - no providers needed */}
        <div className="flex h-screen w-full items-center justify-center p-4">
          <div className="rounded-xl bg-white dark:bg-surface-dark-base p-6 shadow-xl border border-red-200 dark:border-red-900/50 w-full max-w-xl">
            <div className="flex items-center gap-4 mb-6">
              <div className="rounded-full bg-red-100 dark:bg-red-900/30 p-3">
                <IconAlertTriangle
                  size={24}
                  className="text-red-600 dark:text-red-400"
                />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                  Application Error
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  A critical error occurred. Please reload the page.
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 px-4 py-4 mb-6">
              <p className="text-sm text-red-800 dark:text-red-300 font-mono">
                {error.message || 'An unexpected error occurred'}
              </p>
              {error.digest && (
                <p className="text-xs text-red-700 dark:text-red-400 font-mono mt-2">
                  Error ID: {error.digest}
                </p>
              )}
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-white text-sm font-medium flex items-center justify-center gap-2 mb-5"
            >
              <IconRefresh size={16} />
              Reload Page
            </button>

            <p className="text-xs text-gray-600 dark:text-gray-400 text-center">
              If this problem persists, contact support at{' '}
              <a
                href={`mailto:${FEEDBACK_EMAIL}`}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {FEEDBACK_EMAIL}
              </a>
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
