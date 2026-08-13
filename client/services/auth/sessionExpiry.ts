'use client';

import { signOut } from 'next-auth/react';

import { ApiError } from '@/client/services/api/errors';

/**
 * A 401 whose code says the session itself is unusable — either the server
 * rejected an error-flagged session (AUTH_SESSION_EXPIRED: token refresh
 * failed after a client-secret rotation) or there was no session at all
 * (AUTH_FAILED). Both mean the only fix is signing in again.
 *
 * Deliberately strict on `status === 401`: the 403 admin usage-limit denial
 * (RATE_LIMIT_QUOTA_EXCEEDED) and the 429 burst limit must keep their
 * informative banners and must never log the user out.
 */
export function isSessionExpiredApiError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    (error.response?.code === 'AUTH_SESSION_EXPIRED' ||
      error.response?.code === 'AUTH_FAILED')
  );
}

let signOutInFlight = false;

/**
 * Signs the user out and lands them on the signin page's existing
 * "session expired" card (same callbackUrl as SessionErrorHandler, so both
 * paths converge on one UX). Once-guarded: several parallel failing
 * requests trigger a single signOut. No guard reset needed — signOut
 * navigates away.
 */
export function forceSessionExpiredSignOut(): void {
  if (signOutInFlight) return;
  signOutInFlight = true;
  void signOut({ callbackUrl: '/signin?error=SessionExpired', redirect: true });
}
