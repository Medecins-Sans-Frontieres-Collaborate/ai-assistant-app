import { NextRequest } from 'next/server';

import {
  openNativeRunStore,
  parseRunLocation,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import { runStorageErrorResponse } from '@/lib/services/documentTranslation/native/nativeRunResponses';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  RUN_MAX_FILES,
  isRunFileId,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { auth } from '@/auth';

interface SyncRequest {
  runId?: unknown;
  storage?: unknown;
  /** Ids of the files the run still uses; the rest are deleted. */
  keep?: unknown;
  /** False only asks when the run expires. */
  touch?: unknown;
}

/**
 * POST /api/document-translation/native/run
 *
 * Keeps a run's files in step with the browser. Body: `runId`, `storage`
 * and optionally `keep`, the ids of the files still in use: any other file
 * of the run is deleted. In app storage, files not written for a while are
 * touched so the run does not expire while it is worked on; `touch: false`
 * only asks when it expires. 404 `RUN_FILES_MISSING` also when a file in
 * `keep` is gone.
 *
 * Returns `expiresAt` (ISO; null on OneDrive, where nothing expires) and
 * `files`. 404 `RUN_FILES_MISSING` when the run holds no files any more.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  let body: SyncRequest;
  try {
    body = (await req.json()) as SyncRequest;
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  const where = parseRunLocation(
    { runId: body.runId, storage: body.storage },
    req,
  );
  if (!where.ok) return badRequestResponse(where.error);
  let keep: string[] | undefined;
  if (body.keep !== undefined) {
    if (
      !Array.isArray(body.keep) ||
      body.keep.length > RUN_MAX_FILES ||
      !body.keep.every(isRunFileId)
    ) {
      return badRequestResponse(
        `keep must list at most ${RUN_MAX_FILES} run file ids`,
      );
    }
    keep = body.keep;
  }
  try {
    const store = await openNativeRunStore(req, session, where.location);
    return successResponse(await store.sync(keep, body.touch !== false));
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/run] Sync failed:', error);
    return handleApiError(error, 'Could not check the translation run');
  }
}

/**
 * DELETE /api/document-translation/native/run?run=&storage=
 *
 * Deletes a run and all its files. Deleting a run that is already gone
 * succeeds.
 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  const params = req.nextUrl.searchParams;
  const where = parseRunLocation(
    { runId: params.get('run'), storage: params.get('storage') },
    req,
  );
  if (!where.ok) return badRequestResponse(where.error);
  try {
    const store = await openNativeRunStore(req, session, where.location);
    await store.remove();
    return successResponse({ deleted: true });
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/run] Delete failed:', error);
    return handleApiError(error, 'Could not delete the translation run');
  }
}
