/**
 * Server-side import of OneDrive/SharePoint files into user blob storage
 * (third-pass shared foundation).
 *
 * Given {driveId, itemId} and the signed-in user's delegated Graph token,
 * resolves metadata, downloads content via the pre-authenticated
 * @microsoft.graph.downloadUrl (falling back to /content), and lands the
 * bytes at the exact same `{userId}/uploads/{files|images}/{id}.{ext}` shape
 * as a local upload — downstream code cannot tell an M365 import from a
 * local pick, which is the point. Bytes never round-trip through the
 * browser, so large media (the 25MB+ transcription path) imports at server
 * speed.
 *
 * Small files are buffered, validated like the upload route (audio/video
 * signature check, image sanitisation) and content-hashed so re-imports
 * dedupe against identical local uploads. Files above the buffer threshold
 * stream straight to blob under a UUID name (mirroring the chunked-upload
 * naming), with the signature check applied to the leading bytes of the
 * stream — signatures live in the first 16 bytes.
 */
import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import {
  M365Error,
  graphFetch,
  graphJson,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { badRequestResponse } from '@/lib/utils/server/api/apiResponse';
import { validateBufferSignature } from '@/lib/utils/server/file/fileValidation';
import { validateOrSanitizeImageBytes } from '@/lib/utils/server/file/svgSanitization';
import { sanitizeBlobExtension } from '@/lib/utils/shared/blobPath';

import {
  FileCategory,
  getFileCategory,
  getFileSizeLimit,
  getFileSizeLimitDisplay,
} from '@/lib/constants/fileLimits';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

const SCOPES = ['Files.ReadWrite.All'];

/** Above this, content streams to blob instead of buffering for a hash. */
const BUFFER_MAX_BYTES = 32 * 1024 * 1024;

export interface M365ImportTarget {
  driveId: string;
  itemId: string;
}

/** The same reference shape a local upload produces, plus M365 provenance. */
export interface M365ImportedUpload {
  /** `/api/file/{blobFilename}` — identical to a local upload result. */
  uri: string;
  name: string;
  size: number;
  mimeType: string;
  category: FileCategory;
  eTag?: string;
  webUrl?: string;
}

/** Import-specific rejections that map to 4xx, unlike Graph faults. */
export class M365ImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'M365_IS_FOLDER'
      | 'M365_FILE_TOO_LARGE'
      | 'M365_INVALID_CONTENT',
  ) {
    super(message);
    this.name = 'M365ImportError';
  }
}

/** Maps import failures to responses; falls through to the Graph mapping. */
export function m365ImportErrorResponse(error: unknown): NextResponse {
  if (error instanceof M365ImportError) {
    return badRequestResponse(error.message, error.code);
  }
  return m365ErrorResponse(error);
}

interface GraphItemMeta {
  name?: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; id?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

export async function fetchDriveItemMeta(
  req: NextRequest,
  target: M365ImportTarget,
): Promise<GraphItemMeta> {
  return graphJson<GraphItemMeta>(
    req,
    SCOPES,
    `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}` +
      '?$select=name,size,eTag,webUrl,folder,file,parentReference,@microsoft.graph.downloadUrl',
  );
}

async function openContentStream(
  req: NextRequest,
  target: M365ImportTarget,
  meta: GraphItemMeta,
): Promise<Response> {
  // The downloadUrl is pre-authenticated and short-lived; fall back to the
  // /content endpoint (a Graph 302 fetch follows the redirect) without it.
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const content = downloadUrl
    ? await fetch(downloadUrl)
    : await graphFetch(
        req,
        SCOPES,
        `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}/content`,
      );
  if (!content.ok || !content.body) {
    throw new M365Error('Failed to download file content', 'graph_error', 502);
  }
  return content;
}

/**
 * Yields the response body as Buffers, validating the audio/video signature
 * on the leading bytes before anything is written and enforcing the byte
 * cap as the stream flows (Graph metadata or Content-Length can be absent
 * or stale — the stream itself is authoritative).
 */
async function* validatedChunks(
  body: ReadableStream<Uint8Array>,
  name: string,
  checkSignature: boolean,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let first = true;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new M365ImportError(
          'File exceeds the size limit for this operation',
          'M365_FILE_TOO_LARGE',
        );
      }
      if (first) {
        first = false;
        if (checkSignature) {
          const result = validateBufferSignature(chunk, 'any', name);
          if (!result.isValid) {
            throw new M365ImportError(
              result.error ?? 'File content does not match its type',
              'M365_INVALID_CONTENT',
            );
          }
        }
      }
      yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface M365FetchedFile {
  name: string;
  size: number;
  mimeType: string;
  data: Buffer;
  eTag?: string;
  webUrl?: string;
  /** The source's containing folder, for "save next to original" flows. */
  parentFolder?: { driveId: string; itemId: string };
}

/**
 * Fetches a drive item fully into memory WITHOUT writing to blob storage —
 * for routes that consume the bytes directly (e.g. translation, which lands
 * its own `{userId}/translations/…` copies). `maxBytes` lets callers apply
 * a stricter cap than the per-category upload limit.
 */
export async function fetchDriveItemBuffer(
  req: NextRequest,
  target: M365ImportTarget,
  options: { maxBytes?: number } = {},
): Promise<M365FetchedFile> {
  const meta = await fetchDriveItemMeta(req, target);
  if (meta.folder) {
    throw new M365ImportError('Folders cannot be imported', 'M365_IS_FOLDER');
  }
  const name = meta.name ?? 'file';
  const size = meta.size ?? 0;
  const mimeType = meta.file?.mimeType || 'application/octet-stream';
  const category = getFileCategory(name, mimeType);
  const limit = Math.min(
    getFileSizeLimit(category),
    options.maxBytes ?? Number.POSITIVE_INFINITY,
  );
  if (size > limit) {
    throw new M365ImportError(
      `File exceeds the size limit for this operation`,
      'M365_FILE_TOO_LARGE',
    );
  }
  const content = await openContentStream(req, target, meta);
  const data = Buffer.from(await content.arrayBuffer());
  if (data.length > limit) {
    throw new M365ImportError(
      `File exceeds the size limit for this operation`,
      'M365_FILE_TOO_LARGE',
    );
  }
  const parent = meta.parentReference;
  return {
    name,
    size: data.length,
    mimeType,
    data,
    ...(meta.eTag && { eTag: meta.eTag }),
    ...(meta.webUrl && { webUrl: meta.webUrl }),
    ...(parent?.driveId &&
      parent.id && {
        parentFolder: { driveId: parent.driveId, itemId: parent.id },
      }),
  };
}

/**
 * Lands an already-opened Graph content response in the user's upload
 * storage under the local-upload path shape. Shared by the drive-item
 * import and the meeting-recording import (§4), whose content is not a
 * drive item but streams the same way.
 */
export async function storeContentToUploads(
  session: Session,
  content: Response,
  file: { name: string; size: number; mimeType: string },
): Promise<M365ImportedUpload> {
  const { name, size, mimeType } = file;
  const category = getFileCategory(name, mimeType);
  const limit = getFileSizeLimit(category);
  if (size > limit) {
    throw new M365ImportError(
      `File exceeds the ${getFileSizeLimitDisplay(category)} limit for ${category} files`,
      'M365_FILE_TOO_LARGE',
    );
  }
  if (!content.body) {
    throw new M365Error('Failed to download file content', 'graph_error', 502);
  }

  const userId = getUserIdFromSession(session);
  const blobStorage = createBlobStorageClient(session);
  const rawExtension = name.includes('.') ? (name.split('.').pop() ?? '') : '';
  const extension = sanitizeBlobExtension(rawExtension) || 'bin';
  const uploadLocation = category === 'image' ? 'images' : 'files';
  const isAudioVideo = category === 'audio' || category === 'video';
  const blobHTTPHeaders = { blobContentType: mimeType };

  let blobFilename: string;
  let storedSize = size;

  // An unknown size (0) with audio/video must stream — buffering a 1GB
  // recording whose Content-Length is missing would hold it all in memory.
  const stream = size > BUFFER_MAX_BYTES || (size === 0 && isAudioVideo);

  if (!stream) {
    let data: Buffer = Buffer.from(await content.arrayBuffer());
    storedSize = data.length;
    if (storedSize > limit) {
      throw new M365ImportError(
        `File exceeds the ${getFileSizeLimitDisplay(category)} limit for ${category} files`,
        'M365_FILE_TOO_LARGE',
      );
    }
    if (isAudioVideo) {
      const result = validateBufferSignature(data, 'any', name);
      if (!result.isValid) {
        throw new M365ImportError(
          result.error ?? 'File content does not match its type',
          'M365_INVALID_CONTENT',
        );
      }
    }
    if (category === 'image') {
      const result = await validateOrSanitizeImageBytes(data);
      if (!result.ok) {
        throw new M365ImportError(result.error, 'M365_INVALID_CONTENT');
      }
      data = result.data;
      storedSize = data.length;
    }
    // Content-addressed like the upload route, so identical bytes dedupe.
    blobFilename = `${Hasher.sha256(data)}.${extension}`;
    await blobStorage.upload(
      `${userId}/uploads/${uploadLocation}/${blobFilename}`,
      data,
      { blobHTTPHeaders },
    );
  } else {
    // Images never reach this branch (5MB cap); no sanitisation needed.
    blobFilename = `${randomUUID()}.${extension}`;
    const contentStream = Readable.from(
      validatedChunks(
        content.body as ReadableStream<Uint8Array>,
        name,
        isAudioVideo,
        limit,
      ),
    );
    await blobStorage.uploadStream({
      blobName: `${userId}/uploads/${uploadLocation}/${blobFilename}`,
      contentStream,
      options: { blobHTTPHeaders },
    });
  }

  return {
    uri: `/api/file/${blobFilename}`,
    name,
    size: storedSize,
    mimeType,
    category,
  };
}

/**
 * Imports one drive item into the user's upload storage. Throws
 * M365ImportError for folder/size/content rejections and M365Error for
 * Graph faults — route handlers map both via `m365ImportErrorResponse`.
 */
export async function importDriveItemToStorage(
  req: NextRequest,
  session: Session,
  target: M365ImportTarget,
): Promise<M365ImportedUpload> {
  const meta = await fetchDriveItemMeta(req, target);
  if (meta.folder) {
    throw new M365ImportError('Folders cannot be imported', 'M365_IS_FOLDER');
  }

  const name = meta.name ?? 'file';
  const size = meta.size ?? 0;
  const mimeType = meta.file?.mimeType || 'application/octet-stream';
  const category = getFileCategory(name, mimeType);
  const limit = getFileSizeLimit(category);
  if (size > limit) {
    throw new M365ImportError(
      `File exceeds the ${getFileSizeLimitDisplay(category)} limit for ${category} files`,
      'M365_FILE_TOO_LARGE',
    );
  }

  const content = await openContentStream(req, target, meta);
  const stored = await storeContentToUploads(session, content, {
    name,
    size,
    mimeType,
  });

  return {
    ...stored,
    ...(meta.eTag && { eTag: meta.eTag }),
    ...(meta.webUrl && { webUrl: meta.webUrl }),
  };
}
