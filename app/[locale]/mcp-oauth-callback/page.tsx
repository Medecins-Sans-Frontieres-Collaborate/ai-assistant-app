'use client';

import { Suspense, useEffect } from 'react';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

/**
 * OAuth callback target for MCP connectors (registered redirect URI:
 * {origin}/mcp-oauth-callback — localePrefix is 'never', so this
 * app/[locale] page answers without a prefix).
 *
 * Runs in the popup: reads code/state from the query, immediately scrubs
 * them from the URL/history, hands them to the opener tab over
 * BroadcastChannel (in-memory, same-origin by construction), and tries to
 * close itself. The authorization code is never written to any storage.
 * Residual (documented in the plan): the code appears once in this page's
 * request URL — single-use, PKCE-bound, redirect-URI-pinned.
 */
function McpOauthCallbackInner() {
  const t = useTranslations('connectors');
  // useSearchParams captures the initial query; history.replaceState below
  // doesn't go through the Next router, so these stay stable across renders.
  const params = useSearchParams();
  const state = params.get('state');
  const code = params.get('code');
  const error = params.get('error');
  const errorDescription = params.get('error_description');

  useEffect(() => {
    // Scrub the sensitive query from the URL bar and history first.
    window.history.replaceState(null, '', window.location.pathname);

    if (!state) return;

    const channel = new BroadcastChannel('mcp-oauth');
    channel.postMessage({
      state,
      ...(code ? { code } : {}),
      ...(error ? { error } : {}),
      ...(errorDescription ? { errorDescription } : {}),
    });
    channel.close();

    // Providers that navigated the popup through intermediate origins can
    // leave window.close() blocked; the on-page copy covers that case.
    window.close();
    // Params are captured from the initial URL only — run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#171717] p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-black dark:text-white">
          {state ? t('oauthCallback.title') : t('oauthCallback.missingState')}
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t('oauthCallback.close')}
        </p>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-4 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {t('oauthCallback.closeButton')}
        </button>
      </div>
    </div>
  );
}

export default function McpOauthCallbackPage() {
  // useSearchParams requires a Suspense boundary during prerender.
  return (
    <Suspense fallback={null}>
      <McpOauthCallbackInner />
    </Suspense>
  );
}
