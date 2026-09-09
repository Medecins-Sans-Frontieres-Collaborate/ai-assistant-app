import { NextRequest, NextResponse } from 'next/server';

import { encodeViewAsCookie } from '@/lib/services/admin/viewAs';
import {
  VIEW_AS_COOKIE,
  VIEW_AS_MAX_AGE_SECONDS,
  ViewAsOverridesSchema,
  isViewAsEmpty,
  normalizeViewAsOverrides,
} from '@/lib/services/admin/viewAsTypes';
import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';

/**
 * GET/PUT/DELETE /api/admin/view-as — the caller's own "view as" test mode
 * (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * ⚠ Gated on the REAL identity — `isGlobalAdmin(session.user.mail)`, the
 * bare-mail form — never on the (possibly demoted) session user. This is
 * the one surface an admin viewing as a regular user must still be able to
 * reach, or they could not switch back.
 *
 * The cookie is httpOnly + signed + bound to the user id (viewAs.ts), so
 * the only way to set it is this route. It is also inert for anyone who is
 * not a global admin, which the session callback re-checks per request.
 */

function secureCookie(): boolean {
  return (
    (process.env.AUTH_URL || process.env.NEXTAUTH_URL || '').startsWith(
      'https',
    ) || process.env.NODE_ENV === 'production'
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user.mail)) return forbiddenResponse();
  return successResponse({
    active: session.user.viewAs ?? null,
    actual: {
      department:
        session.user.viewAs?.actual.department ?? session.user.department,
      companyName:
        session.user.viewAs?.actual.companyName ?? session.user.companyName,
      jobTitle: session.user.viewAs?.actual.jobTitle ?? session.user.jobTitle,
      officeId: session.user.viewAs?.actual.officeId ?? session.user.officeId,
      region: session.user.actualRegion ?? session.user.region,
      mail: session.user.mail,
    },
  });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user.mail)) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = ViewAsOverridesSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid view-as overrides',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  const overrides = normalizeViewAsOverrides(parsed.data);
  if (isViewAsEmpty(overrides)) {
    return badRequestResponse('No overrides given; use DELETE to clear');
  }

  const value = encodeViewAsCookie(session.user.id, overrides);
  if (!value) {
    return errorResponse(
      'View-as is unavailable: no auth secret configured',
      500,
      undefined,
      'VIEW_AS_UNAVAILABLE',
    );
  }

  console.log(
    `[admin-view-as] action=set by=${sanitizeForLog(session.user.mail)} overrides=${sanitizeForLog(JSON.stringify(overrides))}`,
  );
  const response = NextResponse.json({ success: true, data: { overrides } });
  response.cookies.set({
    name: VIEW_AS_COOKIE,
    value,
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: VIEW_AS_MAX_AGE_SECONDS,
  });
  return response;
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user.mail)) return forbiddenResponse();

  console.log(
    `[admin-view-as] action=clear by=${sanitizeForLog(session.user.mail)}`,
  );
  const response = NextResponse.json({
    success: true,
    data: { cleared: true },
  });
  response.cookies.set({
    name: VIEW_AS_COOKIE,
    value: '',
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
