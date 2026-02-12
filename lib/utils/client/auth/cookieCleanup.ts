/**
 * Cookie Cleanup Utility
 *
 * Handles detection and cleanup of oversized cookies to prevent 431 HTTP errors.
 * Azure Container Apps typically has an 8KB header limit; this utility provides
 * proactive detection and recovery mechanisms.
 */
import { CookieService } from '@/lib/services/cookieService';

/**
 * Cookie name patterns used by NextAuth that should be cleared during cleanup.
 * Includes both standard and secure prefixed variants.
 */
const AUTH_COOKIE_PATTERNS = [
  'authjs.session-token',
  'authjs.callback-url',
  'authjs.csrf-token',
  '__Secure-authjs.session-token',
  '__Secure-authjs.callback-url',
  '__Secure-authjs.csrf-token',
  '__Host-authjs.csrf-token',
  'next-auth.session-token',
  'next-auth.callback-url',
  'next-auth.csrf-token',
  '__Secure-next-auth.session-token',
  '__Secure-next-auth.callback-url',
  '__Secure-next-auth.csrf-token',
];

/**
 * Partial match patterns for auth-related cookies.
 * Used for more flexible matching of cookies that may have variations.
 */
const AUTH_COOKIE_PARTIAL_PATTERNS = ['auth', 'session', 'token', 'csrf'];

/**
 * Default threshold for cookie size detection.
 * Set slightly below Azure Container Apps' ~8KB header limit to catch issues
 * before the server returns a 431 error.
 */
const DEFAULT_COOKIE_SIZE_THRESHOLD = 7000;

/**
 * Clears all authentication-related cookies from the browser.
 *
 * This function identifies and removes cookies that match known auth patterns,
 * attempting deletion on both the current path and root path to ensure complete cleanup.
 *
 * @example
 * ```typescript
 * // Clear all auth cookies when a 431 error is detected
 * clearAuthCookies();
 * window.location.href = '/signin?error=CookiesCleared';
 * ```
 */
export function clearAuthCookies(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const allCookies = CookieService.getAllCookies();

  for (const cookieName of Object.keys(allCookies)) {
    const shouldClear =
      AUTH_COOKIE_PATTERNS.includes(cookieName) ||
      AUTH_COOKIE_PARTIAL_PATTERNS.some((pattern) =>
        cookieName.toLowerCase().includes(pattern),
      );

    if (shouldClear) {
      // Delete cookie with different path variations to ensure cleanup
      CookieService.deleteCookie(cookieName);
      CookieService.deleteCookie(cookieName, '/');

      // Also try to delete with explicit domain variations
      try {
        document.cookie = `${encodeURIComponent(cookieName)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax`;
        document.cookie = `${encodeURIComponent(cookieName)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax; Secure`;
      } catch {
        // Ignore errors from cookie deletion attempts
      }
    }
  }
}

/**
 * Gets the total size of all cookies in bytes.
 *
 * @returns The total size of document.cookie string, or 0 if running server-side.
 *
 * @example
 * ```typescript
 * const cookieSize = getCookieTotalSize();
 * console.log(`Total cookie size: ${cookieSize} bytes`);
 * ```
 */
export function getCookieTotalSize(): number {
  if (typeof document === 'undefined') {
    return 0;
  }
  return document.cookie.length;
}

/**
 * Checks if the current cookie size exceeds the specified threshold.
 *
 * This is used for proactive detection of potentially problematic cookie sizes
 * before they cause 431 errors from the server.
 *
 * @param threshold - The size threshold in bytes (default: 7000)
 * @returns True if cookies exceed the threshold, false otherwise
 *
 * @example
 * ```typescript
 * if (isAuthCookieOversized()) {
 *   clearAuthCookies();
 *   window.location.href = '/signin?error=CookiesCleared';
 * }
 * ```
 */
export function isAuthCookieOversized(
  threshold: number = DEFAULT_COOKIE_SIZE_THRESHOLD,
): boolean {
  return getCookieTotalSize() > threshold;
}

/**
 * Error codes used for redirect URL parameters when cookie cleanup occurs.
 */
export const COOKIE_ERROR_CODES = {
  /** Cookies were proactively cleared due to size */
  COOKIES_CLEARED: 'CookiesCleared',
  /** 431 error was received from server */
  HEADERS_TOO_LARGE: 'HeadersTooLarge',
} as const;

export type CookieErrorCode =
  (typeof COOKIE_ERROR_CODES)[keyof typeof COOKIE_ERROR_CODES];
