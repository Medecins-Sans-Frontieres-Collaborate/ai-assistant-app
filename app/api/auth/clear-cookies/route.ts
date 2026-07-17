import { NextRequest, NextResponse } from 'next/server';

/**
 * All auth cookie prefixes to clear (both v4 and v5).
 * Uses startsWith matching to catch chunked cookies (e.g. `.0`, `.1`, `.2`).
 */
const AUTH_COOKIE_PREFIXES = [
  // NextAuth v5 (authjs)
  'authjs.',
  '__Secure-authjs.',
  '__Host-authjs.',
  // Legacy NextAuth v4
  'next-auth.',
  '__Secure-next-auth.',
];

/**
 * Server-side endpoint to clear all auth cookies (v4 + v5).
 *
 * This is the "nuclear option" for users stuck with 431 errors.
 * Only called via the "Clear Session Data" button on the signin page.
 * Uses Set-Cookie response headers so it can clear httpOnly cookies
 * (which document.cookie cannot access).
 */
export async function POST(req: NextRequest) {
  const response = NextResponse.json({ cleared: true });

  const allCookies = req.cookies.getAll();
  for (const cookie of allCookies) {
    if (AUTH_COOKIE_PREFIXES.some((prefix) => cookie.name.startsWith(prefix))) {
      response.cookies.set(cookie.name, '', {
        expires: new Date(0),
        path: '/',
      });
    }
  }

  return response;
}
