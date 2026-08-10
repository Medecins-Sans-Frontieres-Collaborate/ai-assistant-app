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
  graphErrorFromResponse,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
  mintGraphToken,
} from '@/lib/services/m365/graphApi';
import {
  GraphUploadConflictError,
  SIMPLE_UPLOAD_MAX,
  uploadSessionFragments,
} from '@/lib/services/m365/graphUpload';

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
const MAX_SAVE_BYTES = 50 * 1024 * 1024;
// Multipart framing overhead allowance for the Content-Length pre-check —
// boundaries and field headers, not file bytes.
const MULTIPART_SLACK = 64 * 1024;

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
    throw await graphErrorFromResponse(response);
  }
  return response;
}

/** Windows/OneDrive-reserved base names — rejected by Graph regardless of case. */
const RESERVED_NAME_REGEX = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  // Split the extension off first so length truncation can never amputate
  // it (".docx" must survive an over-long conversation title).
  const dot = cleaned.lastIndexOf('.');
  let ext = dot > 0 ? cleaned.slice(dot) : '';
  let base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  if (!/^\.[A-Za-z0-9]{1,12}$/.test(ext)) {
    // Not a real extension (empty, bare dot, over-long, odd charset) —
    // treat the whole thing as the base name.
    base = cleaned;
    ext = '';
  }
  base = base
    .slice(0, Math.max(1, 120 - ext.length))
    // A name ending in a dot or space is invalid in OneDrive; leading dots
    // and the Office lock-file prefix are stripped rather than rejected.
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '')
    .replace(/^~\$+/, '');
  if (RESERVED_NAME_REGEX.test(base)) {
    base = `${base}-file`;
  }
  return base ? `${base}${ext}` : 'export';
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
  try {
    return await uploadSessionFragments(uploadUrl, bytes, contentType);
  } catch (error) {
    // conflictBehavior=rename means a commit 409 should be impossible here;
    // if Graph produces one anyway it is a fault, not a user conflict.
    if (error instanceof GraphUploadConflictError) {
      throw new M365Error(error.message, 'graph_error', 502);
    }
    throw error;
  }
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
  try {
    return await uploadSessionFragments(
      sessionData.uploadUrl,
      new Uint8Array(await file.arrayBuffer()),
      contentType,
    );
  } catch (error) {
    // The If-Match guard was already checked at session creation; a commit
    // 409 here is a name conflict fault, not a doc-sync conflict.
    if (error instanceof GraphUploadConflictError) {
      throw new M365Error(error.message, 'graph_error', 502);
    }
    throw error;
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  // Reject oversized uploads from the declared length BEFORE formData()
  // materializes the whole body in memory; the post-parse check below still
  // guards senders that lie about (or omit) Content-Length.
  const declaredLength = Number(req.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SAVE_BYTES + MULTIPART_SLACK
  ) {
    return payloadTooLargeResponse('50MB');
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
          // A view, not a copy — the file is already fully buffered.
          body: new Uint8Array(await file.arrayBuffer()),
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
