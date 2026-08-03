/**
 * Create sharing permissions on a OneDrive item the user owns.
 *
 * POST /api/m365/share  { driveId, itemId, emails?: string[] }
 *
 * Always a direct, user-initiated action (the Share dialog) on a file the
 * app just saved via /api/m365/save — never triggered from model output.
 * Two modes:
 *   - no emails → an ORGANIZATION-scoped view link (Graph createLink).
 *     People in the tenant with the link can read; nothing is public.
 *   - emails    → view grants for those specific people (Graph invite,
 *     no notification mail — the sharer sends the link themselves).
 * Both are view-only: sharing a chat is disclosure, not collaboration.
 *
 * Tenant sharing policies (DLP, sensitivity labels, external-sharing
 * settings) apply server-side at Graph; their rejections surface as typed
 * M365 errors rather than being retried or masked.
 */
import { NextRequest } from 'next/server';

import {
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Files.ReadWrite.All'];

/** Sanity bound; Graph invite accepts fewer anyway. */
const MAX_RECIPIENTS = 20;

// Pragmatic RFC-lite check — Graph validates resolvability; this only
// keeps garbage out of the request body.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface GraphPermission {
  link?: { webUrl?: string };
  grantedToV2?: unknown;
  invitation?: unknown;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let body: {
    driveId?: unknown;
    itemId?: unknown;
    emails?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return badRequestResponse('Expected a JSON body');
  }

  const { driveId, itemId } = body;
  if (typeof driveId !== 'string' || !isValidGraphId(driveId)) {
    return badRequestResponse('Invalid driveId');
  }
  if (typeof itemId !== 'string' || !isValidGraphId(itemId)) {
    return badRequestResponse('Invalid itemId');
  }

  let emails: string[] = [];
  if (body.emails !== undefined) {
    if (
      !Array.isArray(body.emails) ||
      body.emails.length > MAX_RECIPIENTS ||
      !body.emails.every(
        (e): e is string =>
          typeof e === 'string' && e.length <= 320 && EMAIL_RE.test(e),
      )
    ) {
      return badRequestResponse('Invalid emails');
    }
    emails = body.emails;
  }

  const itemPath = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;

  try {
    if (emails.length === 0) {
      const permission = await graphJson<GraphPermission>(
        req,
        SCOPES,
        `${itemPath}/createLink`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'view', scope: 'organization' }),
        },
      );
      const link = permission.link?.webUrl;
      if (!link) {
        return badRequestResponse('Graph returned no sharing link');
      }
      return successResponse({ link, scope: 'organization' });
    }

    await graphJson<{ value?: GraphPermission[] }>(
      req,
      SCOPES,
      `${itemPath}/invite`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: emails.map((email) => ({ email })),
          requireSignIn: true,
          sendInvitation: false,
          roles: ['read'],
        }),
      },
    );
    return successResponse({ scope: 'people', granted: emails.length });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
