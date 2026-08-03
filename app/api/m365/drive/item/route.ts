/**
 * Single drive-item metadata read for document sync.
 *
 * GET /api/m365/drive/item?driveId=…&itemId=…
 *
 * The doc-sync pull poll: returns just enough to detect a remote change
 * (eTag) plus display fields, and the containing folder so "keep both"
 * conflict copies can land next to the bound file. Folders are rejected —
 * only files can be bound.
 */
import { NextRequest } from 'next/server';

import { isValidGraphId } from '@/lib/services/m365/graphApi';
import {
  fetchDriveItemMeta,
  m365ImportErrorResponse,
} from '@/lib/services/m365/m365ImportService';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const driveId = req.nextUrl.searchParams.get('driveId');
  const itemId = req.nextUrl.searchParams.get('itemId');
  if (!isValidGraphId(driveId) || !isValidGraphId(itemId)) {
    return badRequestResponse('Invalid driveId or itemId');
  }

  try {
    const meta = await fetchDriveItemMeta(req, { driveId, itemId });
    if (meta.folder) {
      return badRequestResponse('Folders cannot be bound', 'M365_IS_FOLDER');
    }
    const parent = meta.parentReference;
    return successResponse({
      name: meta.name ?? 'file',
      ...(meta.eTag && { eTag: meta.eTag }),
      ...(meta.webUrl && { webUrl: meta.webUrl }),
      ...(meta.size !== undefined && { size: meta.size }),
      ...(parent?.driveId &&
        parent.id && {
          parentFolder: { driveId: parent.driveId, itemId: parent.id },
        }),
    });
  } catch (error) {
    return m365ImportErrorResponse(error);
  }
}
