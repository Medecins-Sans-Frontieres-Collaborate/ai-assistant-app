import { NextRequest } from 'next/server';

import { AnnouncementsService } from '@/lib/services/announcements/AnnouncementsService';
import {
  isAnnouncementsAdmin,
  resolveAnnouncementsAdmin,
} from '@/lib/services/announcements/adminAccess';
import {
  AnnouncementsConflictError,
  createAnnouncementsBlobStorage,
  mutateAnnouncements,
  writeAnnouncementsHistory,
} from '@/lib/services/announcements/announcementsStore';
import {
  ANNOUNCEMENT_ID_RE,
  Announcement,
} from '@/lib/services/announcements/types';
import {
  announcementWriteSchema,
  mayManage,
  toStoredAnnouncement,
  validateAnnouncementWrite,
} from '@/lib/services/announcements/writePath';

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

/**
 * PUT/DELETE /api/admin/announcements/[id] — replace or delete ONE record.
 *
 * A delegated sender cannot tell an unknown id from a foreign one: both
 * answer the same 403 (CWE-203). Only a global admin, who reads the whole
 * document anyway, gets a 404.
 */

function conflictResponse() {
  return errorResponse(
    'Announcements were modified at the same time; retry',
    409,
    undefined,
    'ANNOUNCEMENTS_CONFLICT',
  );
}

function notFoundOrForbidden(isGlobalAdmin: boolean) {
  return isGlobalAdmin
    ? errorResponse('Announcement not found', 404, undefined, 'NOT_FOUND')
    : forbiddenResponse();
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnnouncementsAdmin(session.user);
  if (!isAnnouncementsAdmin(status)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const { id } = await params;
  if (!ANNOUNCEMENT_ID_RE.test(id)) {
    return badRequestResponse('Invalid announcement id');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = announcementWriteSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid announcement',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }

  try {
    const storage = createAnnouncementsBlobStorage();
    const now = new Date().toISOString();
    let saved: Announcement | null = null;
    const result = await mutateAnnouncements(storage, (current) => {
      const existing = current.announcements.find((a) => a.id === id);
      if (!existing || !mayManage(status, existing)) {
        return { abort: notFoundOrForbidden(status.isGlobalAdmin) };
      }
      // Authority never moves with an edit: validate against the record's
      // OWN delegation, whatever the body says.
      const input = { ...parsed.data, delegationId: existing.delegationId };
      const invalid = validateAnnouncementWrite(input, {
        status,
        document: current,
        existingId: id,
      });
      if (invalid) {
        return {
          abort: errorResponse(
            invalid.message,
            invalid.status ?? 400,
            invalid.details,
            invalid.code,
          ),
        };
      }
      saved = toStoredAnnouncement(input, id, existing, userMail, now);
      return {
        ...current,
        version: 1,
        announcements: current.announcements.map((a) =>
          a.id === id ? (saved as Announcement) : a,
        ),
        updatedBy: userMail,
        updatedAt: now,
      };
    });
    if (result.abort) return result.abort;

    const announcement = saved as Announcement | null;
    console.log(
      `[announcements-admin] action=${parsed.data.status === 'withdrawn' ? 'withdraw' : 'update'} id=${id} status=${parsed.data.status} revision=${announcement?.revision} dismissible=${parsed.data.dismissible} by=${sanitizeForLog(userMail)}`,
    );
    await writeAnnouncementsHistory(storage, {
      version: 1,
      action: parsed.data.status === 'withdrawn' ? 'withdraw' : 'upsert',
      announcement,
      updatedBy: userMail,
      updatedAt: now,
    });
    AnnouncementsService.getInstance().invalidate();
    return successResponse({ announcement });
  } catch (error) {
    if (error instanceof AnnouncementsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to update announcement');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnnouncementsAdmin(session.user);
  if (!isAnnouncementsAdmin(status)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const { id } = await params;
  if (!ANNOUNCEMENT_ID_RE.test(id)) {
    return badRequestResponse('Invalid announcement id');
  }

  try {
    const storage = createAnnouncementsBlobStorage();
    const now = new Date().toISOString();
    let removed: Announcement | null = null;
    const result = await mutateAnnouncements(storage, (current) => {
      const existing = current.announcements.find((a) => a.id === id);
      if (!existing || !mayManage(status, existing)) {
        return { abort: notFoundOrForbidden(status.isGlobalAdmin) };
      }
      removed = existing;
      return {
        ...current,
        version: 1,
        announcements: current.announcements.filter((a) => a.id !== id),
        updatedBy: userMail,
        updatedAt: now,
      };
    });
    if (result.abort) return result.abort;

    console.log(
      `[announcements-admin] action=delete id=${id} by=${sanitizeForLog(userMail)}`,
    );
    await writeAnnouncementsHistory(storage, {
      version: 1,
      action: 'delete',
      announcement: removed,
      updatedBy: userMail,
      updatedAt: now,
    });
    AnnouncementsService.getInstance().invalidate();
    return successResponse({ deleted: id });
  } catch (error) {
    if (error instanceof AnnouncementsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to delete announcement');
  }
}
