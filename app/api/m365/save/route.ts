/**
 * Save an app-produced file to the user's OneDrive or a SharePoint library.
 *
 * POST /api/m365/save  (multipart: file, fileName[, driveId[, parentId]])
 *
 * Always a direct, user-initiated action (the "Save to OneDrive" menu item)
 * — never triggered from model output. Without a target the file lands in
 * the fixed app folder `/Apps/AI Assistant/`; with a driveId (plus optional
 * parentId folder) it goes to any drive the user can write to. Delegated
 * `Files.ReadWrite.All` suffices for SharePoint library writes too — Sites
 * scopes are only needed for site discovery (`Sites.Read.All`), not here.
 *
 * Targets use Graph's id+path colon addressing
 * (`/drives/{d}/items/{parent}:/{name}:`) — creating a NEW file under an
 * id-addressed parent requires it; a pure id PUT can only overwrite an
 * existing item.
 *
 * ≤4MB uploads use the single-shot content PUT; larger files go through an
 * upload session in 5MB chunks (Graph requires 320KiB multiples). Conflicts
 * rename rather than overwrite — saving twice must never destroy anything.
 *
 * Overwrite mode (doc-sync push): with `itemId` (+ required `driveId`) the
 * PUT targets that EXISTING item's content — an explicit overwrite of a
 * bound file, so no conflictBehavior=rename. An `ifMatch` eTag guards the
 * write; a Graph 412 maps to 409 M365_CONFLICT so the client can open its
 * conflict flow instead of blindly clobbering a remote edit.
 */
import { NextRequest } from 'next/server';

import {
  GRAPH_V1,
  M365Error,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
  mintGraphToken,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const maxDuration = 120;

const SCOPES = ['Files.ReadWrite.All'];
const APP_FOLDER = 'Apps/AI Assistant';
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
// 16 × 320KiB — Graph upload-session fragments must be 320KiB multiples.
const CHUNK_SIZE = 16 * 327_680;
const MAX_SAVE_BYTES = 50 * 1024 * 1024;

interface SavedItem {
  id?: string;
  name?: string;
  webUrl?: string;
  eTag?: string;
  parentReference?: { driveId?: string };
}

interface SaveTarget {
  driveId: string;
  parentId?: string;
}

interface OverwriteTarget {
  driveId: string;
  itemId: string;
  ifMatch?: string;
}

/** Graph 412 on an If-Match-guarded overwrite — the remote moved on. */
class OverwriteConflictError extends Error {
  constructor() {
    super('The file changed in OneDrive since the last sync');
    this.name = 'OverwriteConflictError';
  }
}

/**
 * Fetches Graph for the overwrite path with a 412 kept distinct — the
 * shared graphFetch collapses 412 into a generic graph_error before the
 * route can see it, and this mode's whole contract is the conflict signal.
 * Other statuses map exactly like graphFetch so error codes stay uniform.
 */
async function graphOverwriteFetch(
  req: NextRequest,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const token = await mintGraphToken(req, SCOPES);
  const response = await fetch(`${GRAPH_V1}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (response.status === 412) {
    throw new OverwriteConflictError();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body?.error?.message || `Graph request failed (${response.status})`;
    if (response.status === 404) {
      throw new M365Error(message, 'not_found', 404);
    }
    if (response.status === 403 || response.status === 401) {
      throw new M365Error(message, 'forbidden', 403);
    }
    throw new M365Error(message, 'graph_error', 502);
  }
  return response;
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^\.+/, '');
  return cleaned || 'export';
}

function itemPath(fileName: string, target?: SaveTarget): string {
  if (target) {
    const drive = `/drives/${encodeURIComponent(target.driveId)}`;
    // parentId targets a folder; without one the drive root (a SharePoint
    // document-library root) is the destination.
    return target.parentId
      ? `${drive}/items/${encodeURIComponent(target.parentId)}:/${encodeURIComponent(fileName)}:`
      : `${drive}/root:/${encodeURIComponent(fileName)}:`;
  }
  const encodedFolder = APP_FOLDER.split('/').map(encodeURIComponent).join('/');
  return `/me/drive/root:/${encodedFolder}/${encodeURIComponent(fileName)}:`;
}

// The uploadUrl is pre-authenticated; fragments go directly to it.
async function uploadFragments(
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<SavedItem> {
  let item: SavedItem = {};
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.length);
    const fragment = bytes.slice(offset, end);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
      },
      body: fragment,
    });
    if (!response.ok) {
      throw new M365Error(
        `Chunk upload failed (${response.status})`,
        'graph_error',
        502,
      );
    }
    if (end === bytes.length) {
      item = (await response.json().catch(() => ({}))) as SavedItem;
    }
  }
  return item;
}

async function uploadLarge(
  req: NextRequest,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
  target?: SaveTarget,
): Promise<SavedItem> {
  const sessionData = await graphJson<{ uploadUrl?: string }>(
    req,
    SCOPES,
    `${itemPath(fileName, target)}/createUploadSession`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'rename' },
      }),
    },
  );
  const uploadUrl = sessionData.uploadUrl;
  if (!uploadUrl) {
    throw new M365Error('Upload session was not created', 'graph_error', 502);
  }
  return uploadFragments(uploadUrl, bytes, contentType);
}

function overwriteItemPath(target: OverwriteTarget): string {
  return `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}`;
}

/** Overwrites an existing item's content. No conflictBehavior=rename here —
 * this mode is an explicit overwrite of a bound file; safety comes from the
 * If-Match guard instead. */
async function overwriteContent(
  req: NextRequest,
  file: Blob,
  contentType: string,
  target: OverwriteTarget,
): Promise<SavedItem> {
  const ifMatchHeader: Record<string, string> = target.ifMatch
    ? { 'If-Match': target.ifMatch }
    : {};
  if (file.size <= SIMPLE_UPLOAD_MAX) {
    const response = await graphOverwriteFetch(
      req,
      `${overwriteItemPath(target)}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType, ...ifMatchHeader },
        body: Buffer.from(await file.arrayBuffer()),
      },
    );
    return (await response.json()) as SavedItem;
  }

  // Large overwrite: If-Match travels on the createUploadSession request
  // itself (Graph's shape for guarded session uploads — the precondition is
  // checked when the session is created, not per fragment).
  const sessionResponse = await graphOverwriteFetch(
    req,
    `${overwriteItemPath(target)}/createUploadSession`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ifMatchHeader },
      body: JSON.stringify({}),
    },
  );
  const sessionData = (await sessionResponse.json()) as {
    uploadUrl?: string;
  };
  if (!sessionData.uploadUrl) {
    throw new M365Error('Upload session was not created', 'graph_error', 502);
  }
  return uploadFragments(
    sessionData.uploadUrl,
    new Uint8Array(await file.arrayBuffer()),
    contentType,
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequestResponse('Expected multipart form data');
  }
  const file = form.get('file');
  const rawName = form.get('fileName');
  const driveId = form.get('driveId');
  const parentId = form.get('parentId');
  const itemId = form.get('itemId');
  const ifMatch = form.get('ifMatch');
  if (!(file instanceof Blob)) {
    return badRequestResponse('Missing file');
  }
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return badRequestResponse('Missing fileName');
  }
  if (
    driveId !== null &&
    (typeof driveId !== 'string' || !isValidGraphId(driveId))
  ) {
    return badRequestResponse('Invalid driveId');
  }
  if (
    parentId !== null &&
    (typeof parentId !== 'string' || !isValidGraphId(parentId))
  ) {
    return badRequestResponse('Invalid parentId');
  }
  if (parentId !== null && driveId === null) {
    return badRequestResponse('parentId requires driveId');
  }
  if (
    itemId !== null &&
    (typeof itemId !== 'string' || !isValidGraphId(itemId))
  ) {
    return badRequestResponse('Invalid itemId');
  }
  if (itemId !== null && driveId === null) {
    return badRequestResponse('itemId requires driveId');
  }
  // Overwrite targets an item directly; a parent folder is a different mode.
  if (itemId !== null && parentId !== null) {
    return badRequestResponse('itemId and parentId are mutually exclusive');
  }
  if (ifMatch !== null && itemId === null) {
    return badRequestResponse('ifMatch requires itemId');
  }
  // ifMatch becomes an HTTP header verbatim — bound its charset before it
  // can alter the request (eTags are quoted printable-ASCII strings).
  if (
    ifMatch !== null &&
    (typeof ifMatch !== 'string' ||
      ifMatch.length > 512 ||
      !/^[\x20-\x7e]+$/.test(ifMatch))
  ) {
    return badRequestResponse('Invalid ifMatch');
  }
  if (file.size > MAX_SAVE_BYTES) {
    return payloadTooLargeResponse('50MB');
  }

  const target: SaveTarget | undefined =
    typeof driveId === 'string'
      ? { driveId, ...(typeof parentId === 'string' && { parentId }) }
      : undefined;
  const fileName = sanitizeFileName(rawName);
  const contentType = file.type || 'application/octet-stream';

  if (typeof itemId === 'string' && typeof driveId === 'string') {
    try {
      const item = await overwriteContent(req, file, contentType, {
        driveId,
        itemId,
        ...(typeof ifMatch === 'string' && { ifMatch }),
      });
      return successResponse({
        name: item.name ?? fileName,
        webUrl: item.webUrl,
        ...(item.eTag && { eTag: item.eTag }),
      });
    } catch (error) {
      if (error instanceof OverwriteConflictError) {
        return errorResponse(error.message, 409, undefined, 'M365_CONFLICT');
      }
      return m365ErrorResponse(error);
    }
  }

  try {
    let item: SavedItem;
    if (file.size <= SIMPLE_UPLOAD_MAX) {
      const response = await graphJson<SavedItem>(
        req,
        SCOPES,
        `${itemPath(fileName, target)}/content?@microsoft.graph.conflictBehavior=rename`,
        {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: Buffer.from(await file.arrayBuffer()),
        },
      );
      item = response;
    } else {
      item = await uploadLarge(
        req,
        fileName,
        new Uint8Array(await file.arrayBuffer()),
        contentType,
        target,
      );
    }

    // Explicit destinations omit `folder` — the client already holds the
    // human-readable label for the folder it picked. itemId/driveId/eTag
    // let doc-sync bind the file it just created.
    return successResponse({
      name: item.name ?? fileName,
      webUrl: item.webUrl,
      ...(item.eTag && { eTag: item.eTag }),
      ...(item.id && { itemId: item.id }),
      ...(item.parentReference?.driveId && {
        driveId: item.parentReference.driveId,
      }),
      ...(!target && { folder: APP_FOLDER }),
    });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
