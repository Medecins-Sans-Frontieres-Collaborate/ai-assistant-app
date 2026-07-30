/**
 * Save an app-produced file to the user's OneDrive.
 *
 * POST /api/m365/save  (multipart: file, fileName)
 *
 * Always a direct, user-initiated action (the "Save to OneDrive" menu item)
 * — never triggered from model output. v1 target is the fixed app folder
 * `/Apps/AI Assistant/`; a folder/SharePoint picker is a follow-up
 * (`Sites.ReadWrite.All` is granted but unused here).
 *
 * ≤4MB uploads use the single-shot content PUT; larger files go through an
 * upload session in 5MB chunks (Graph requires 320KiB multiples). Conflicts
 * rename rather than overwrite — saving twice must never destroy anything.
 */
import { NextRequest } from 'next/server';

import {
  M365Error,
  graphJson,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
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

function itemPath(fileName: string): string {
  const encodedFolder = APP_FOLDER.split('/').map(encodeURIComponent).join('/');
  return `/me/drive/root:/${encodedFolder}/${encodeURIComponent(fileName)}:`;
}

async function uploadLarge(
  req: NextRequest,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<SavedItem> {
  const sessionData = await graphJson<{ uploadUrl?: string }>(
    req,
    SCOPES,
    `${itemPath(fileName)}/createUploadSession`,
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

  // The uploadUrl is pre-authenticated; fragments go directly to it.
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
  if (!(file instanceof Blob)) {
    return badRequestResponse('Missing file');
  }
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return badRequestResponse('Missing fileName');
  }
  if (file.size > MAX_SAVE_BYTES) {
    return payloadTooLargeResponse('50MB');
  }

  const fileName = sanitizeFileName(rawName);
  const contentType = file.type || 'application/octet-stream';

  try {
    let item: SavedItem;
    if (file.size <= SIMPLE_UPLOAD_MAX) {
      const response = await graphJson<SavedItem>(
        req,
        SCOPES,
        `${itemPath(fileName)}/content?@microsoft.graph.conflictBehavior=rename`,
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
      );
    }

    return successResponse({
      name: item.name ?? fileName,
      webUrl: item.webUrl,
      folder: APP_FOLDER,
    });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
