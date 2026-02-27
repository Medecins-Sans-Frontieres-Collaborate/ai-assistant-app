/**
 * Cookie Cleanup Utility
 *
 * Handles user-initiated cleanup of auth cookies when 431 (Request Header Fields
 * Too Large) errors occur. This utility only clears cookies when explicitly
 * triggered by the user to avoid login loops caused by automatic clearing.
 */
import { CookieService } from '@/lib/services/cookieService';

/**
 * Auth cookie patterns to clear. Using exact matches only to avoid
 * accidentally clearing unrelated cookies from third-party services.
 */
const AUTH_COOKIE_EXACT_PATTERNS = [
  // NextAuth v5 (authjs) cookies
  'authjs.session-token',
  'authjs.callback-url',
  'authjs.csrf-token',
  '__Secure-authjs.session-token',
  '__Secure-authjs.callback-url',
  '__Secure-authjs.csrf-token',
  '__Host-authjs.csrf-token',
  // Legacy NextAuth v4 cookies (for users with old accumulated cookies)
  'next-auth.session-token',
  'next-auth.callback-url',
  'next-auth.csrf-token',
  '__Secure-next-auth.session-token',
  '__Secure-next-auth.callback-url',
  '__Secure-next-auth.csrf-token',
];

/**
 * Error codes used for redirect URL parameters when cookie-related issues occur.
 */
export const COOKIE_ERROR_CODES = {
  /** 431 error was received from server - headers too large */
  HEADERS_TOO_LARGE: 'HeadersTooLarge',
} as const;

export type CookieErrorCode =
  (typeof COOKIE_ERROR_CODES)[keyof typeof COOKIE_ERROR_CODES];

/**
 * Clears all known auth cookies from the browser.
 *
 * This function should only be called when the user explicitly requests
 * cookie clearing (e.g., by clicking a "Clear Session Data" button).
 * Automatic clearing has been shown to cause login loops.
 *
 * Uses exact-match patterns only to avoid clearing unrelated cookies
 * from LaunchDarkly or other third-party services.
 *
 * @example
 * ```typescript
 * // In response to user clicking "Clear Session Data" button
 * const handleClearSession = async () => {
 *   const { clearAuthCookies } = await import('@/lib/utils/client/auth/cookieCleanup');
 *   clearAuthCookies();
 *   window.location.href = '/signin';
 * };
 * ```
 */
export function clearAuthCookies(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const allCookies = CookieService.getAllCookies();

  for (const cookieName of Object.keys(allCookies)) {
    // Only clear cookies that exactly match known auth patterns
    if (AUTH_COOKIE_EXACT_PATTERNS.includes(cookieName)) {
      // Try multiple deletion methods to ensure cleanup
      CookieService.deleteCookie(cookieName);
      CookieService.deleteCookie(cookieName, '/');

      // Additional deletion attempts for stubborn cookies
      try {
        document.cookie = `${encodeURIComponent(cookieName)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
        document.cookie = `${encodeURIComponent(cookieName)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; Secure;`;
      } catch {
        // Ignore errors from cookie deletion attempts
      }
    }
  }
}
