import { deleteBackupPrefix } from '@/lib/services/backup/server/backupBlobStore';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { classifyStorageError } from '@/lib/utils/server/blob/storageErrors';

import { auth } from '@/auth';

/**
 * DELETE `/api/backup` — wipes every blob under the caller's
 * `${userId}/backup/` prefix (manifest + all ciphertext). Used by the
 * "Turn off & delete backup" flow; the client separately writes a disabled
 * tombstone manifest so other devices see "disabled", not "never existed".
 * Idempotent: deleting an absent backup succeeds with `deleted: 0`.
 */

/** Wipes are rare, destructive, and enumerate the whole prefix — keep tight. */
const limiter = RateLimiter.createScoped(10, 1);

export async function DELETE() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = getUserIdFromSession(session);
  if (userId === 'anonymous') return unauthorizedResponse();

  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }

  try {
    const storage = createBlobStorageClient(session);
    const deleted = await deleteBackupPrefix(storage, userId);
    return successResponse({ deleted });
  } catch (error) {
    const { errorClass, status, message } = classifyStorageError(error);
    console.error(
      `[BackupRoute] DELETE failed (class=${errorClass}, status=${status}):`,
      error,
    );
    return errorResponse(message, status, undefined, errorClass.toUpperCase());
  }
}
