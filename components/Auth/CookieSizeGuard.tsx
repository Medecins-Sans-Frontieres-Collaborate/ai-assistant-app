'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';

import {
  COOKIE_ERROR_CODES,
  clearAuthCookies,
  isAuthCookieOversized,
} from '@/lib/utils/client/auth/cookieCleanup';

interface CookieSizeGuardProps {
  children: ReactNode;
}

/**
 * Guards against oversized cookies that would cause 431 HTTP errors.
 *
 * This component runs a check on mount to detect if cookies exceed a safe size
 * threshold. If oversized cookies are detected, it clears auth cookies and
 * redirects to the signin page with an explanatory error code.
 *
 * This provides a proactive defense against 431 errors that can occur when
 * users have accumulated old session cookies from previous versions.
 *
 * @example
 * ```tsx
 * // Wrap your app providers to ensure cookie check runs early
 * <CookieSizeGuard>
 *   <SessionProvider>
 *     {children}
 *   </SessionProvider>
 * </CookieSizeGuard>
 * ```
 */
export function CookieSizeGuard({ children }: CookieSizeGuardProps) {
  const [isReady, setIsReady] = useState(false);
  const hasChecked = useRef(false);

  useEffect(() => {
    // Prevent double-check in StrictMode
    if (hasChecked.current) {
      return;
    }
    hasChecked.current = true;

    // Check if cookies are oversized before allowing app to proceed
    if (isAuthCookieOversized()) {
      console.warn(
        '[CookieSizeGuard] Oversized cookies detected, clearing auth cookies',
      );
      clearAuthCookies();

      // Redirect to signin with reason
      // Using window.location.href ensures full page reload and fresh state
      window.location.href = `/signin?error=${COOKIE_ERROR_CODES.COOKIES_CLEARED}`;
      return;
    }

    // Use requestAnimationFrame to defer state update and avoid the lint error
    // about synchronous setState in effects
    requestAnimationFrame(() => {
      setIsReady(true);
    });
  }, []);

  // Don't render children until cookie check passes
  // This prevents any authenticated requests from being made with oversized cookies
  if (!isReady) {
    return null;
  }

  return <>{children}</>;
}
