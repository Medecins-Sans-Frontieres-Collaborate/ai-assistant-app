import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';

import { locales, routing } from './config/i18n';

import { auth } from '@/auth';

const handleI18nRouting = createMiddleware(routing);

// Public pages that don't require authentication
const publicPages = ['/signin', '/auth-error'];

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
