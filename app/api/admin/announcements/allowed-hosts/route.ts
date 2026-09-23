import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { AnnouncementsService } from '@/lib/services/announcements/AnnouncementsService';
import {
  AnnouncementsConflictError,
  createAnnouncementsBlobStorage,
  mutateAnnouncements,
  writeAnnouncementsHistory,
} from '@/lib/services/announcements/announcementsStore';
import {
  ANNOUNCEMENT_ID_RE,
  MAX_ALLOWED_HOSTS,
  httpsHostOf,
} from '@/lib/services/announcements/types';

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
 * POST/DELETE /api/admin/announcements/allowed-hosts — the hosts a DELEGATED
 * sender may link to. Global admins only.
 *
 * POST accepts EITHER a `host` or an `announcementId`: the second is the
 * "allow the host this message links to" shortcut — a delegated sender saves
 * a draft whose link host is not approved yet, and a global admin approves it
 * straight from that message. The host is taken from the STORED record,
 * never from the request, so what gets approved is what the admin reviewed.
 */

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const postSchema = z
  .object({
    host: z.string().max(253).optional(),
    announcementId: z.string().regex(ANNOUNCEMENT_ID_RE).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.host === undefined) !== (value.announcementId === undefined),
    'Provide exactly one of host or announcementId',
  );

async function authorize() {
  const session = await auth();
  if (!session?.user) return { response: unauthorizedResponse() };
  if (!isGlobalAdmin(session.user)) return { response: forbiddenResponse() };
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return { response: forbiddenResponse() };
  return { userMail };
}

function conflictResponse() {
  return errorResponse(
    'Announcements were modified at the same time; retry',
    409,
    undefined,
    'ANNOUNCEMENTS_CONFLICT',
  );
}

export async function POST(request: NextRequest) {
  const authz = await authorize();
  if (authz.response) return authz.response;
  const { userMail } = authz;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse('Provide exactly one of host or announcementId');
  }

  try {
    const storage = createAnnouncementsBlobStorage();
    const now = new Date().toISOString();
    let added = '';
    const result = await mutateAnnouncements(storage, (current) => {
      const host = parsed.data.announcementId
        ? httpsHostOf(
            current.announcements.find(
              (a) => a.id === parsed.data.announcementId,
            )?.action?.url,
          )
        : (parsed.data.host ?? '').trim().toLowerCase();
      if (!host || !HOST_RE.test(host)) {
        return {
          abort: badRequestResponse(
            parsed.data.announcementId
              ? 'That announcement has no https link to approve'
              : 'Not a valid host name',
          ),
        };
      }
      added = host;
      if (current.allowedLinkHosts.includes(host)) return { ...current };
      if (current.allowedLinkHosts.length >= MAX_ALLOWED_HOSTS) {
        return { abort: badRequestResponse('The allow-list is full') };
      }
      return {
        ...current,
        version: 1,
        allowedLinkHosts: [...current.allowedLinkHosts, host].sort(),
        updatedBy: userMail,
        updatedAt: now,
      };
    });
    if (result.abort) return result.abort;

    console.log(
      `[announcements-admin] action=allow-host host=${sanitizeForLog(added)} via=${parsed.data.announcementId ? 'announcement' : 'manual'} by=${sanitizeForLog(userMail)}`,
    );
    await writeAnnouncementsHistory(storage, {
      version: 1,
      action: 'allow-host',
      announcement: null,
      host: added,
      updatedBy: userMail,
      updatedAt: now,
    });
    AnnouncementsService.getInstance().invalidate();
    return successResponse({
      host: added,
      allowedLinkHosts: result.document.allowedLinkHosts,
    });
  } catch (error) {
    if (error instanceof AnnouncementsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to allow host');
  }
}

export async function DELETE(request: NextRequest) {
  const authz = await authorize();
  if (authz.response) return authz.response;
  const { userMail } = authz;

  const host = (request.nextUrl.searchParams.get('host') ?? '')
    .trim()
    .toLowerCase();
  if (!host) return badRequestResponse('host is required');

  try {
    const storage = createAnnouncementsBlobStorage();
    const now = new Date().toISOString();
    const result = await mutateAnnouncements(storage, (current) => ({
      ...current,
      version: 1,
      allowedLinkHosts: current.allowedLinkHosts.filter((h) => h !== host),
      updatedBy: userMail,
      updatedAt: now,
    }));
    if (result.abort) return result.abort;

    console.log(
      `[announcements-admin] action=remove-host host=${sanitizeForLog(host)} by=${sanitizeForLog(userMail)}`,
    );
    await writeAnnouncementsHistory(storage, {
      version: 1,
      action: 'remove-host',
      announcement: null,
      host,
      updatedBy: userMail,
      updatedAt: now,
    });
    AnnouncementsService.getInstance().invalidate();
    return successResponse({
      allowedLinkHosts: result.document.allowedLinkHosts,
    });
  } catch (error) {
    if (error instanceof AnnouncementsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to remove host');
  }
}
