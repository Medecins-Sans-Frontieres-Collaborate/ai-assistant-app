/**
 * Server-side M365 import: land a OneDrive/SharePoint file directly in the
 * user's upload storage without round-tripping bytes through the browser.
 *
 * POST /api/m365/import/storage  { driveId, itemId }
 *
 * Returns the same reference shape as a local upload (`/api/file/{id}`), so
 * callers hand it straight to the attachment/processing pipeline. Counts
 * against the same daily upload limit as a local upload — this is an upload
 * with a different source, not a way around the caps.
 */
import { NextRequest } from 'next/server';

import { guardLimit } from '@/lib/services/limits/routeGuard';
import { isValidGraphId } from '@/lib/services/m365/graphApi';
import {
  importDriveItemToStorage,
  m365ImportErrorResponse,
} from '@/lib/services/m365/m365ImportService';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let body: { driveId?: unknown; itemId?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  const driveId = typeof body.driveId === 'string' ? body.driveId : null;
  const itemId = typeof body.itemId === 'string' ? body.itemId : null;
  if (!isValidGraphId(driveId) || !isValidGraphId(itemId)) {
    return badRequestResponse('Invalid driveId or itemId');
  }

  const uploadGuard = await guardLimit(session, 'feature.upload.filesPerDay', {
    req,
  });
  if (!uploadGuard.allowed && uploadGuard.response) {
    return uploadGuard.response;
  }

  try {
    const imported = await importDriveItemToStorage(req, session, {
      driveId,
      itemId,
    });
    return successResponse(imported);
  } catch (error) {
    // Nothing was stored — hand the reserved daily-upload unit back so a
    // rejected or failed import doesn't burn quota.
    await uploadGuard.rollback?.();
    return m365ImportErrorResponse(error);
  }
}
