import { NextRequest } from 'next/server';

import { GlobalAdminRosterService } from '@/lib/services/admin/GlobalAdminRosterService';
import {
  GlobalAdminsConflictError,
  createGlobalAdminsBlobStorage,
  readGlobalAdmins,
  writeGlobalAdmins,
  writeGlobalAdminsHistoryEntry,
} from '@/lib/services/admin/globalAdminsStore';
import {
  GlobalAdminRoster,
  normalizeAdminMail,
} from '@/lib/services/admin/globalAdminsTypes';
import {
  isGlobalAdmin,
  parseGlobalAdminEmails,
} from '@/lib/services/agentAccess/adminAuth';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * GET/PUT /api/admin/global-admins — the config-based global admin roster
 * (`system/admin/global-admins.json`, design §13). GLOBAL admins only, gated
 * on the EFFECTIVE identity so a view-as-demoted admin is bounced exactly like
 * every other admin route (exit view-as first to edit the roster).
 *
 * The env roster (`AGENT_ACCESS_ADMINS`) is read-only here — it is the
 * un-lockable bootstrap, echoed so the UI can list it as "set by deployment".
 * The PUT refuses to leave the config roster empty while the env roster is
 * also empty (`GLOBAL_ADMINS_LOCKOUT`); it does allow an admin to remove
 * themselves when someone else remains (logged as a warning).
 *
 * Same CAS pattern as /api/agent-access/config (If-Match update / absent
 * If-Match create-only, 412 → 409). GET reads storage directly rather than the
 * ≤60s-stale service snapshot so the echoed ETag is current for editing.
 */

/**
 * WRITE-side schema only — stricter than GlobalAdminRosterSchema (which must
 * keep accepting every persisted blob): strict keys, size caps, and a
 * must-look-like-a-mail check so a stray display name cannot be granted.
 */
const putBodySchema = z
  .object({
    admins: z
      .array(
        z
          .string()
          .trim()
          .min(3)
          .max(320)
          .refine((s) => s.includes('@'), 'must be a mail address'),
      )
      .max(200),
  })
  .strict();

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    // Harmless warm-up: a config admin whose replica is cold gets recognised
    // by the gates below this one on the same request.
    await GlobalAdminRosterService.getInstance().ensureFresh();
    const result = await readGlobalAdmins(createGlobalAdminsBlobStorage());
    return successResponse({
      roster: result?.roster ?? null,
      etag: result?.etag ?? null,
      envAdmins: parseGlobalAdminEmails(),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to read global admins');
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail || !isGlobalAdmin(session.user)) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid global admins body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  // Persist canonical so the stored roster is exactly what isGlobalAdmin
  // matches on.
  const admins = [...new Set(parsed.data.admins.map(normalizeAdminMail))];
  const envAdmins = parseGlobalAdminEmails();

  if (admins.length === 0 && envAdmins.length === 0) {
    // The env roster is the un-lockable bootstrap; when a deployment relies
    // entirely on the config roster, emptying it would lock everyone out.
    return errorResponse(
      'Refusing to remove the last global admin: AGENT_ACCESS_ADMINS is empty, so an empty roster would lock every administrator out',
      400,
      undefined,
      'GLOBAL_ADMINS_LOCKOUT',
    );
  }

  const roster: GlobalAdminRoster = {
    version: 1,
    admins,
    updatedBy: userMail,
    updatedAt: new Date().toISOString(),
  };

  const service = GlobalAdminRosterService.getInstance();
  try {
    const storage = createGlobalAdminsBlobStorage();
    const etag = await writeGlobalAdmins(storage, roster, ifMatchEtag);
    service.invalidate();
    console.log(
      `[global-admins] action=write count=${admins.length} by=${sanitizeForLog(userMail)}`,
    );
    if (!admins.includes(userMail) && !envAdmins.includes(userMail)) {
      console.warn(
        `[global-admins] WARNING self-removal by=${sanitizeForLog(userMail)}: the caller is no longer a global admin once the snapshot refreshes`,
      );
    }
    await writeGlobalAdminsHistoryEntry(storage, {
      version: 1,
      action: 'upsert',
      roster,
      updatedBy: userMail,
      updatedAt: roster.updatedAt,
    });
    return successResponse({ etag });
  } catch (error) {
    if (error instanceof GlobalAdminsConflictError) {
      // Another replica just won the CAS — refresh this replica promptly
      // instead of serving the roster stale for ≤60s.
      service.invalidate();
      return errorResponse(
        'Roster was modified by another admin; reload and retry',
        409,
        undefined,
        'GLOBAL_ADMINS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to write global admins');
  }
}
