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
  readAnnouncements,
  writeAnnouncementsHistory,
} from '@/lib/services/announcements/announcementsStore';
import { Announcement } from '@/lib/services/announcements/types';
import {
  announcementWriteSchema,
  mayAuthorUnder,
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
import { randomBytes } from 'crypto';

/**
 * GET/POST /api/admin/announcements (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md).
 *
 * Global admins see and author everything. A delegated sender (grant
 * `announcements`) sees and authors ONLY the records of their own
 * delegations — the list is filtered server-side, never client-side.
 *
 * Writes are single-record read-modify-writes under CAS, never a
 * whole-document PUT: two admins editing different announcements must not
 * revert each other.
 */

function newAnnouncementId(): string {
  return `ann-${randomBytes(6).toString('hex')}`;
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status, delegations, delegationsUnavailable } =
    await resolveAnnouncementsAdmin(session.user);
  if (!isAnnouncementsAdmin(status)) return forbiddenResponse();

  try {
    const result = await readAnnouncements(createAnnouncementsBlobStorage());
    const all = result?.document.announcements ?? [];
    return successResponse({
      announcements: all.filter((a) => mayManage(status, a)),
      allowedLinkHosts: result?.document.allowedLinkHosts ?? [],
      // Labels and jurisdictions for the delegations the caller may author
      // under (all of them for a global admin). Admin rosters stay out.
      delegations: delegations
        .filter(
          (d) =>
            d.capabilities.includes('announcements') &&
            (status.isGlobalAdmin || status.delegationIds.includes(d.id)),
        )
        .map((d) => ({
          id: d.id,
          label: d.label,
          enabled: d.enabled,
          jurisdiction: d.jurisdiction,
        })),
      isGlobalAdmin: status.isGlobalAdmin,
      unavailable: delegationsUnavailable,
    });
  } catch (error) {
    // Never answer "nothing published" on a read failure.
    console.error(
      `[announcements-admin] read failed: ${sanitizeForLog(error)}`,
    );
    return successResponse({
      announcements: [],
      allowedLinkHosts: [],
      delegations: [],
      isGlobalAdmin: status.isGlobalAdmin,
      unavailable: true,
    });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnnouncementsAdmin(session.user);
  if (!isAnnouncementsAdmin(status)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

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
  // Authorize BEFORE anything is looked up (uniform 403, CWE-203).
  if (!mayAuthorUnder(status, parsed.data.delegationId)) {
    return forbiddenResponse();
  }

  try {
    const storage = createAnnouncementsBlobStorage();
    const now = new Date().toISOString();
    let created: Announcement | null = null;
    const result = await mutateAnnouncements(storage, (current) => {
      const invalid = validateAnnouncementWrite(parsed.data, {
        status,
        document: current,
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
      created = toStoredAnnouncement(
        parsed.data,
        newAnnouncementId(),
        undefined,
        userMail,
        now,
      );
      return {
        ...current,
        version: 1,
        announcements: [...current.announcements, created],
        updatedBy: userMail,
        updatedAt: now,
      };
    });
    if (result.abort) return result.abort;

    const announcement = created as Announcement | null;
    console.log(
      `[announcements-admin] action=create id=${announcement?.id} status=${parsed.data.status} audience=${parsed.data.audience.kind} delegation=${sanitizeForLog(parsed.data.delegationId ?? 'global')} dismissible=${parsed.data.dismissible} by=${sanitizeForLog(userMail)}`,
    );
    await writeAnnouncementsHistory(storage, {
      version: 1,
      action: 'upsert',
      announcement,
      updatedBy: userMail,
      updatedAt: now,
    });
    AnnouncementsService.getInstance().invalidate();
    return successResponse({ announcement });
  } catch (error) {
    if (error instanceof AnnouncementsConflictError) {
      return errorResponse(
        'Announcements were modified at the same time; retry',
        409,
        undefined,
        'ANNOUNCEMENTS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to create announcement');
  }
}
