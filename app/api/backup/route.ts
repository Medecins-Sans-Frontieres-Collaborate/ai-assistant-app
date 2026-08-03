import { NextRequest } from 'next/server';

import { deleteBackupPrefix } from '@/lib/services/backup/server/backupBlobStore';
import { deleteDriveBackup } from '@/lib/services/backup/server/backupDriveStore';
import {
  driveErrorResponse,
  resolveBackupBackend,
} from '@/lib/services/backup/server/routeHelpers';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { classifyStorageError } from '@/lib/utils/server/blob/storageErrors';

import { auth } from '@/auth';

/**
 * DELETE `/api/backup[?backend=]` — wipes the caller's backup in the selected
 * storage backend: every blob under `${userId}/backup/` for app storage, or
 * the `Apps/AI Assistant/Backup` OneDrive folder for the onedrive backend.
 * Used by the "Turn off & delete backup" flow and by backend switching (the
 * old location is wiped after a successful migration push); the client
 * separately writes a disabled tombstone manifest so other devices see
 * "disabled", not "never existed". Idempotent: deleting an absent backup
 * succeeds with `deleted: 0`.
 */

/** Wipes are rare, destructive, and enumerate the whole prefix — keep tight. */
const limiter = RateLimiter.createScoped(10, 1);

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = getUserIdFromSession(session);
  if (userId === 'anonymous') return unauthorizedResponse();

  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }
  const backend = resolveBackupBackend(request);
  if (backend === null) {
    return badRequestResponse('Invalid backend parameter');
  }

  try {
    const deleted =
      backend === 'onedrive'
        ? await deleteDriveBackup(request)
        : await deleteBackupPrefix(createBlobStorageClient(session), userId);
    return successResponse({ deleted });
  } catch (error) {
    const driveResponse = driveErrorResponse(error);
    if (driveResponse) return driveResponse;
    const { errorClass, status, message } = classifyStorageError(error);
    console.error(
      `[BackupRoute] DELETE failed (class=${errorClass}, status=${status}):`,
      error,
    );
    return errorResponse(message, status, undefined, errorClass.toUpperCase());
  }
}
