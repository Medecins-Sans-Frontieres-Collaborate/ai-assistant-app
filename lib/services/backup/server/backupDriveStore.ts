import { NextRequest } from 'next/server';

import {
  BackupConflictError,
  isValidConversationId,
  isValidRev,
} from '@/lib/services/backup/server/backupBlobStore';
import { BackupManifest } from '@/lib/services/backup/types';
import {
  GRAPH_V1,
  M365Error,
  mintGraphToken,
} from '@/lib/services/m365/graphApi';

/**
 * OneDrive-backed storage for the E2E-encrypted chat backup — the Graph
 * counterpart of `backupBlobStore`. Identity comes from the delegated Graph
 * token (the user's own drive), so unlike the blob store no userId prefix is
 * needed. Layout, mirroring the app-storage blob layout, under the fixed
 * app folder:
 *
 *   `Apps/AI Assistant/Backup/manifest.json`       — plaintext manifest,
 *                                                    eTag compare-and-swap
 *   `Apps/AI Assistant/Backup/conv/{id}.{rev}.bin` — immutable ciphertext
 *   `Apps/AI Assistant/Backup/folders.{rev}.bin`   — immutable ciphertext
 *
 * The same envelope encryption applies as for app storage — OneDrive only
 * ever sees opaque ciphertext plus the manifest (ids, revs, timestamps,
 * sizes, key fingerprint).
 *
 * CAS semantics map onto Graph:
 *   - update-if-unchanged → `If-Match: <driveItem.eTag>` (412 on loss)
 *   - create-only         → `@microsoft.graph.conflictBehavior=fail`
 *                           (409 nameAlreadyExists on loss)
 * Both are translated to {@link BackupConflictError} so the routes' 409
 * mapping is backend-agnostic. Graph throttling (429) is preserved as
 * {@link DriveRateLimitError} so routes can propagate Retry-After and the
 * client's existing 429 backoff applies.
 *
 * All ids/revs are validated against the SAME strict regexes as the blob
 * store before any path interpolation.
 */

const SCOPES = ['Files.ReadWrite.All'];

/** Kept alongside /api/m365/save's `Apps/AI Assistant` app folder. */
export const DRIVE_BACKUP_FOLDER = 'Apps/AI Assistant/Backup';

/** Graph simple content PUT cap; larger bodies need an upload session. */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
// 16 × 320KiB — Graph upload-session fragments must be 320KiB multiples.
const CHUNK_SIZE = 16 * 327_680;

/** Graph 429 — surfaces Retry-After so the route can propagate it. */
export class DriveRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Microsoft Graph throttled the request');
    this.name = 'DriveRateLimitError';
  }
}

interface DriveItemShape {
  id?: string;
  eTag?: string;
  size?: number;
  '@microsoft.graph.downloadUrl'?: string;
}

function encodedFolderPath(): string {
  return DRIVE_BACKUP_FOLDER.split('/').map(encodeURIComponent).join('/');
}

/** `conv/{id}.{rev}.bin` — relative to the backup folder; inputs validated. */
export function driveConversationPath(id: string, rev: string): string {
  if (!isValidConversationId(id)) {
    throw new Error('Invalid backup conversation id');
  }
  if (!isValidRev(rev)) {
    throw new Error('Invalid backup blob revision');
  }
  return `conv/${id}.${rev}.bin`;
}

export function driveFoldersPath(rev: string): string {
  if (!isValidRev(rev)) {
    throw new Error('Invalid backup blob revision');
  }
  return `folders.${rev}.bin`;
}

/** `/me/drive/root:/Apps/AI Assistant/Backup/<relPath>:` item addressing. */
function itemUrl(relPath: string, suffix = ''): string {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${GRAPH_V1}/me/drive/root:/${encodedFolderPath()}/${encoded}:${suffix}`;
}

/**
 * Raw Graph fetch that keeps the statuses this store's contract depends on
 * (412 CAS loss, 409 nameAlreadyExists, 429 throttle) distinct — the shared
 * graphFetch collapses everything non-OK into a generic 502 M365Error.
 */
async function driveFetch(
  req: NextRequest,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await mintGraphToken(req, SCOPES);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new DriveRateLimitError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
    );
  }
  return response;
}

async function graphErrorFrom(
  response: Response,
  fallback: string,
): Promise<M365Error> {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message || `${fallback} (${response.status})`;
  if (response.status === 404) {
    return new M365Error(message, 'not_found', 404);
  }
  if (response.status === 401 || response.status === 403) {
    return new M365Error(message, 'forbidden', 403);
  }
  return new M365Error(message, 'graph_error', 502);
}

/**
 * Reads an item's bytes + eTag. Two steps by necessity — Graph's content
 * endpoint redirects to a pre-authed URL that does not carry the item eTag,
 * so metadata (eTag + downloadUrl) comes first and the bytes second. A torn
 * read (item replaced between the two) can only produce a stale-etag CAS
 * loss later, which the sync engine already resolves by re-pulling.
 */
async function downloadItem(
  req: NextRequest,
  relPath: string,
): Promise<{ buffer: Buffer; etag: string } | null> {
  const metaResponse = await driveFetch(req, itemUrl(relPath), {
    method: 'GET',
  });
  if (metaResponse.status === 404) return null;
  if (!metaResponse.ok) {
    throw await graphErrorFrom(metaResponse, 'Backup item lookup failed');
  }
  const item = (await metaResponse.json()) as DriveItemShape;
  const downloadUrl = item['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) {
    throw new M365Error(
      'Backup item has no downloadable content',
      'graph_error',
      502,
    );
  }
  // The downloadUrl is pre-authenticated and short-lived; no token needed.
  const contentResponse = await fetch(downloadUrl);
  if (!contentResponse.ok) {
    throw new M365Error(
      `Backup item download failed (${contentResponse.status})`,
      'graph_error',
      502,
    );
  }
  const buffer = Buffer.from(await contentResponse.arrayBuffer());
  return { buffer, etag: item.eTag ?? '' };
}

export interface DriveManifestReadResult {
  manifest: BackupManifest;
  /** Quoted Graph driveItem eTag — echoed to the client for If-Match CAS. */
  etag: string;
}

/** Reads and parses the manifest. Returns null when no backup exists. */
export async function readDriveManifest(
  req: NextRequest,
): Promise<DriveManifestReadResult | null> {
  const result = await downloadItem(req, 'manifest.json');
  if (result === null) return null;
  const manifest = JSON.parse(result.buffer.toString('utf8')) as BackupManifest;
  return { manifest, etag: result.etag };
}

/**
 * Compare-and-swap manifest write; same contract as the blob store:
 * `ifMatchEtag` set → If-Match update; null → create-only. Either losing
 * race throws {@link BackupConflictError}. Returns the new item eTag.
 *
 * Path-based content PUT auto-creates missing parent folders (the same
 * behavior /api/m365/save relies on for the app folder).
 */
export async function writeDriveManifest(
  req: NextRequest,
  manifest: BackupManifest,
  ifMatchEtag: string | null,
): Promise<string> {
  const body = Buffer.from(JSON.stringify(manifest), 'utf8');
  const suffix = ifMatchEtag
    ? '/content'
    : '/content?@microsoft.graph.conflictBehavior=fail';
  const response = await driveFetch(req, itemUrl('manifest.json', suffix), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(ifMatchEtag ? { 'If-Match': ifMatchEtag } : {}),
    },
    body,
  });
  if (response.status === 412 || response.status === 409) {
    throw new BackupConflictError();
  }
  if (!response.ok) {
    throw await graphErrorFrom(response, 'Backup manifest write failed');
  }
  const item = (await response.json()) as DriveItemShape;
  return item.eTag ?? '';
}

// The uploadUrl is pre-authenticated; fragments go directly to it.
async function uploadFragments(
  uploadUrl: string,
  bytes: Buffer,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.length);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
      },
      body: bytes.subarray(offset, end),
    });
    if (!response.ok) {
      throw new M365Error(
        `Backup chunk upload failed (${response.status})`,
        'graph_error',
        502,
      );
    }
  }
}

/**
 * Writes a rev-named ciphertext item, create-only. Rev names are
 * client-generated random hex, so an item that already exists at this path
 * IS this content — a name conflict is idempotent success (mirror of the
 * blob store's If-None-Match: * handling).
 */
export async function writeDriveImmutableBlob(
  req: NextRequest,
  relPath: string,
  content: Buffer,
): Promise<void> {
  if (content.length <= SIMPLE_UPLOAD_MAX) {
    const response = await driveFetch(
      req,
      itemUrl(relPath, '/content?@microsoft.graph.conflictBehavior=fail'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
      },
    );
    if (response.status === 409) return; // already landed — idempotent
    if (!response.ok) {
      throw await graphErrorFrom(response, 'Backup blob write failed');
    }
    return;
  }

  const sessionResponse = await driveFetch(
    req,
    itemUrl(relPath, '/createUploadSession'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'fail' },
      }),
    },
  );
  if (sessionResponse.status === 409) return; // already landed — idempotent
  if (!sessionResponse.ok) {
    throw await graphErrorFrom(sessionResponse, 'Backup upload session failed');
  }
  const session = (await sessionResponse.json()) as { uploadUrl?: string };
  if (!session.uploadUrl) {
    throw new M365Error('Upload session was not created', 'graph_error', 502);
  }
  await uploadFragments(session.uploadUrl, content);
}

/** Reads a ciphertext item. Returns null when it does not exist. */
export async function readDriveBlob(
  req: NextRequest,
  relPath: string,
): Promise<Buffer | null> {
  const result = await downloadItem(req, relPath);
  return result === null ? null : result.buffer;
}

/** Deletes one item. Idempotent — absent items return false. */
export async function deleteDriveBlob(
  req: NextRequest,
  relPath: string,
): Promise<boolean> {
  const response = await driveFetch(req, itemUrl(relPath), {
    method: 'DELETE',
  });
  if (response.status === 404) return false;
  if (!response.ok && response.status !== 204) {
    throw await graphErrorFrom(response, 'Backup item delete failed');
  }
  return true;
}

/**
 * Deletes the whole backup folder (manifest + ciphertext) in one call.
 * Idempotent; returns 1 when the folder existed, 0 when it never did. The
 * folder lands in the OneDrive recycle bin per Graph delete semantics —
 * the user's own drive, the user's own retention.
 */
export async function deleteDriveBackup(req: NextRequest): Promise<number> {
  const url = `${GRAPH_V1}/me/drive/root:/${encodedFolderPath()}:`;
  const response = await driveFetch(req, url, { method: 'DELETE' });
  if (response.status === 404) return 0;
  if (!response.ok && response.status !== 204) {
    throw await graphErrorFrom(response, 'Backup folder delete failed');
  }
  return 1;
}
