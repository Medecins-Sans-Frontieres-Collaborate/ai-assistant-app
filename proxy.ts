import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';

import { locales, routing } from './config/i18n';

import { auth } from '@/auth';

const handleI18nRouting = createMiddleware(routing);

// Public pages that don't require authentication
const publicPages = ['/signin', '/auth-error'];

// --------------------------------------------------------------------------
// Cookie Size Protection (prevents 431 Request Header Fields Too Large errors)
// --------------------------------------------------------------------------

/**
 * Size threshold for cookie detection.
 * Set slightly below Azure Container Apps' ~8KB header limit to catch issues
 * before the server returns a 431 error.
 */
const COOKIE_SIZE_THRESHOLD = 7000;

/**
 * Patterns for identifying auth-related cookies that should be cleared.
 * Includes NextAuth, Auth.js, and common session cookie naming conventions.
 */
const AUTH_COOKIE_PATTERNS = [
  'authjs.session-token',
  'authjs.callback-url',
  'authjs.csrf-token',
  '__Secure-authjs',
  '__Host-authjs',
  'next-auth.session-token',
  'next-auth.callback-url',
  'next-auth.csrf-token',
  '__Secure-next-auth',
];

/**
 * Partial match patterns for flexible cookie identification.
 */
// More specific patterns to avoid false positives (e.g., 'my-authorization-preference')
const AUTH_COOKIE_PARTIAL_PATTERNS = [
  'authjs',
  'next-auth',
  '-session-token',
  '-csrf-token',
  '-callback-url',
];

/**
 * Calculates total cookie size from request headers.
 *
 * @param req - The incoming Next.js request
 * @returns The character length of the cookie header
 */
function getCookieSizeFromRequest(req: NextRequest): number {
  const cookieHeader = req.headers.get('cookie') || '';
  return cookieHeader.length;
}

/**
 * Determines if a cookie name should be cleared based on auth patterns.
 *
 * @param cookieName - The name of the cookie to check
 * @returns True if the cookie should be cleared
 */
function shouldClearCookie(cookieName: string): boolean {
  const lowerName = cookieName.toLowerCase();
  return (
    AUTH_COOKIE_PATTERNS.some((pattern) => cookieName.includes(pattern)) ||
    AUTH_COOKIE_PARTIAL_PATTERNS.some((pattern) => lowerName.includes(pattern))
  );
}

/**
 * Creates a response that clears all auth cookies and redirects to signin.
 *
 * This function sets expired cookies via Set-Cookie headers, which instructs
 * the browser to remove them. The redirect ensures a clean state for re-authentication.
 *
 * @param req - The incoming request
 * @returns A redirect response with cookie-clearing headers
 */
function createCookieClearResponse(req: NextRequest): NextResponse {
  // Extract locale from current path to preserve it in redirect
  const pathname = req.nextUrl.pathname;
  const localeMatch = pathname.match(LOCALE_PREFIX_REGEX);
  const locale = localeMatch ? localeMatch[1] : '';

  const signInPath = locale ? `/${locale}/signin` : '/signin';
  const signInUrl = new URL(signInPath, req.url);
  signInUrl.searchParams.set('error', 'CookiesCleared');

  const response = NextResponse.redirect(signInUrl);

  // Clear all auth-related cookies by setting them to expire immediately
  const cookies = req.cookies.getAll();
  for (const cookie of cookies) {
    if (shouldClearCookie(cookie.name)) {
      // Secure-prefixed cookies require secure attribute to be cleared
      const isSecurePrefixed =
        cookie.name.startsWith('__Secure-') ||
        cookie.name.startsWith('__Host-');

      response.cookies.set(cookie.name, '', {
        expires: new Date(0),
        path: '/',
        ...(isSecurePrefixed && { secure: true }),
      });
    }
  }

  return response;
}

// Regex to extract locale prefix from pathname (e.g., '/fr/dashboard' -> 'fr')
const LOCALE_PREFIX_REGEX = new RegExp(`^/(${locales.join('|')})/`);

// Regex to match public pages with optional locale prefix
const publicPathnameRegex = RegExp(
  `^(/(${locales.join('|')})?)?(${publicPages.map((p) => p.replace('/', '\\/')).join('|')})/?$`,
  'i',
);

// Auth middleware that also handles i18n
const authMiddleware = auth((req) => {
  // For authenticated routes, run i18n middleware
  if (!req.auth) {
    const signInUrl = new URL('/signin', req.url);
    return NextResponse.redirect(signInUrl);
  }

  const response = handleI18nRouting(req as unknown as NextRequest);

  // If i18n is trying to redirect (307/308), just continue instead
  // This prevents redirect loops when localePrefix is 'never'
  if (response && (response.status === 307 || response.status === 308)) {
    return NextResponse.next();
  }

  return response;
});

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // --------------------------------------------------------------------------
  // Cookie Size Check (must run FIRST, before any other processing)
  // --------------------------------------------------------------------------
  // Skip cookie check for API routes and static files to avoid interfering
  // with legitimate large requests or breaking asset loading
  const skipCookieCheck =
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/signin') ||
    pathname.startsWith('/auth-error') ||
    pathname.includes('.');

  if (!skipCookieCheck) {
    const cookieSize = getCookieSizeFromRequest(req);
    if (cookieSize > COOKIE_SIZE_THRESHOLD) {
      console.warn('[Middleware] Oversized cookies detected, clearing:', {
        size: cookieSize,
        threshold: COOKIE_SIZE_THRESHOLD,
        pathname,
      });
      return createCookieClearResponse(req);
    }
  }

  // Debug: Log proxy headers to diagnose cookie issues (Azure only)
  // Log on root, signin, and auth callback paths where redirect loops occur
  const shouldLog =
    process.env.NODE_ENV !== 'development' &&
    (pathname === '/' ||
      pathname === '/signin' ||
      pathname.startsWith('/api/auth'));

  if (shouldLog) {
    const authCookies = req.cookies
      .getAll()
      .filter((c) => c.name.includes('auth'))
      .map((c) => ({ name: c.name, valueLength: c.value.length }));

    console.log('[Middleware Debug]', {
      pathname,
      host: req.headers.get('host'),
      xForwardedHost: req.headers.get('x-forwarded-host'),
      xForwardedProto: req.headers.get('x-forwarded-proto'),
      xForwardedFor: req.headers.get('x-forwarded-for'),
      protocol: req.nextUrl.protocol,
      url: req.url,
      nextUrl: req.nextUrl.href,
      origin: req.headers.get('origin'),
      referer: req.headers.get('referer'),
      totalCookies: req.cookies.getAll().length,
      authCookies: authCookies.length,
      authCookieDetails: authCookies,
    });
  }

  // Skip API routes and static files entirely
  if (pathname.startsWith('/api') || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const isPublicPage = publicPathnameRegex.test(pathname);

  // For public pages, only run i18n middleware (don't wrap in auth)
  if (isPublicPage) {
    return handleI18nRouting(req);
  }

  // For protected pages, run auth middleware which includes i18n
  return (authMiddleware as any)(req);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files
    '/((?!_next|_vercel|.*\\..*).*)',
  ],
};
