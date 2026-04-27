import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { getAzureMonitorLogger } from '@/lib/services/observability';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { validateImageSignature } from '@/lib/utils/server/file/imageSignature';
import {
  getContentType,
  validateBufferSignature,
  validateFileNotExecutable,
} from '@/lib/utils/server/file/mimeTypes';

import { auth } from '@/auth';
import {
  FileCategory,
  getFileCategory,
  getFileSizeLimit,
  validateFileSizeRaw,
} from '@/lib/constants/fileLimits';

/**
 * Route segment config to allow large file uploads.
 * Next.js App Router defaults to 1MB body size limit.
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
 *
 * 60s was too tight for legitimate slow uploads — a 50MB file on a 1Mbps
 * cellular connection takes ~7 minutes, and the route handler timed out
 * mid-stream with no resumability. 300s covers the worst plausible
 * small-file (≤10MB) upload at very low bandwidth and stays well within
 * the Azure Container Apps deployment's request timeout. Files >10MB go
 * via the chunked Server Action path and are not affected by this.
 */
export const maxDuration = 300;

/**
 * Margin above the per-category size cap to allow for multipart envelope
 * overhead (boundaries, Content-Disposition headers per field). 4KB is
 * generous for a single-field upload — actual overhead is closer to
 * ~200 bytes — but cheap to allow.
 */
const MULTIPART_OVERHEAD_BYTES = 4 * 1024;

/**
 * Buffers the request body into an `ArrayBuffer` and rejects when the size
 * exceeds `maxBytes`. The body is consumed via `arrayBuffer()` (undici-
 * internal consumption) rather than a manual reader to avoid races with the
 * test environment's synthetic body source. The size check still runs before
 * `formData()` parses fields and allocates `File` objects, so an oversized
 * payload is rejected before the expensive multipart parse.
 *
 * Returns the raw ArrayBuffer rather than a Buffer so callers can pass it
 * straight into `new Response(arrayBuffer)` without an intermediate copy —
 * `Buffer.from(arrayBuffer)` is zero-copy but `new Uint8Array(buffer)`
 * isn't, so going through Buffer adds an unnecessary materialization for
 * large bodies.
 *
 * Returns null when the cap is exceeded; the caller should respond 413.
 */
async function readBoundedBody(
  request: NextRequest,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const arrayBuffer = await request.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) return null;
  return arrayBuffer;
}

/**
 * Validates a MIME type from a query parameter against `type/subtype` shape.
 * The MIME is set as `blobContentType` on the stored blob and echoed in
 * `Content-Type` when the blob is served — without this, an attacker could
 * pass `mime=text/html` (or worse) and influence how downstream clients
 * render their content. We accept ASCII letters, digits, and a small set
 * of well-known MIME punctuation. Reject anything else.
 */
function isValidMimeType(value: string): boolean {
  if (value.length > 127) return false;
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[ \t]*[a-zA-Z0-9!#$&^_.+-]+=[a-zA-Z0-9!#$&^_.+-]+)*$/.test(
    value,
  );
}

/**
 * The body-size cap to enforce for the streaming bound.
 *
 * Multipart bodies pay a small envelope overhead (boundaries, headers); the
 * legacy text-body path is base64-encoded so it's ~33% larger than the raw
 * bytes. A 5MB image base64-encoded is ~6.7MB, so we allow `1.4× cap` for
 * the legacy path.
 */
function computeStreamCap(
  category: FileCategory,
  isMultipart: boolean,
): number {
  const rawCap = getFileSizeLimit(category);
  return isMultipart
    ? rawCap + MULTIPART_OVERHEAD_BYTES
    : Math.ceil(rawCap * 1.4) + MULTIPART_OVERHEAD_BYTES;
}

/**
 * Per-request inputs derived from query params + content-type. Lifted from
 * the POST handler so the helper functions below can take a single
 * parameter instead of closing over named locals.
 */
interface UploadContext {
  filename: string;
  filetype: string;
  mimeType: string | null;
  isImage: boolean;
}

/**
 * Stores the validated file at the user's hashed blob path. Image-content
 * validation runs here for the multipart binary path; the legacy text path
 * validates earlier at decode time and feeds in the data-URL string.
 *
 * Throws `Error` on internal storage failure; returns the badRequest reason
 * string when the data fails content validation (caller converts to 400).
 */
async function storeFile(
  data: Buffer | string,
  ctx: UploadContext,
  session: Session,
): Promise<{ ok: true; uri: string } | { ok: false; error: string }> {
  const userId = getUserIdFromSession(session);
  const blobStorageClient: BlobStorage = createBlobStorageClient(session);

  // Hash data directly — Hasher accepts both Buffer and string. For buffers,
  // this avoids the base64 string length limit for large files.
  const hashedFileContents = Hasher.sha256(data);
  const extension: string | undefined = ctx.filename.split('.').pop();

  let contentType: string;
  if (ctx.mimeType) {
    contentType = ctx.mimeType;
  } else if (extension) {
    contentType = getContentType(extension);
  } else {
    contentType = 'application/octet-stream';
  }

  const uploadLocation = ctx.filetype === 'image' ? 'images' : 'files';

  const isAudioVideo =
    (ctx.mimeType &&
      (ctx.mimeType.startsWith('audio/') ||
        ctx.mimeType.startsWith('video/'))) ||
    ctx.filetype === 'audio' ||
    ctx.filetype === 'video';

  if (isAudioVideo && Buffer.isBuffer(data)) {
    const result = validateBufferSignature(data, 'any', ctx.filename);
    if (!result.isValid) {
      return {
        ok: false,
        error:
          result.error ??
          'File content does not match expected audio/video format',
      };
    }
  }

  // Image content check on the binary path. The legacy text path validated
  // its own bytes at decode time and passes a string here, which we don't
  // re-validate (re-decoding would be wasteful).
  if (ctx.isImage && Buffer.isBuffer(data)) {
    const result = validateImageSignature(data);
    if (!result.isValid) {
      return { ok: false, error: result.error ?? 'Invalid image content' };
    }
  }

  const uri = await blobStorageClient.upload(
    `${userId}/uploads/${uploadLocation}/${hashedFileContents}.${extension}`,
    data,
    {
      blobHTTPHeaders: { blobContentType: contentType },
    },
  );
  return { ok: true, uri };
}

/**
 * Decodes the legacy `data:image/...;base64,...` body into a Buffer for
 * content validation, then returns the original data URL string for storage
 * (preserving backward compat with `getBlobBase64String`'s data:-prefix
 * branch). Returns the error string when the body isn't a valid image data
 * URL — caller converts to 400.
 */
function validateLegacyImageDataUrl(
  rawData: string,
): { ok: true; storage: string } | { ok: false; error: string } {
  const dataUrlMatch = rawData.match(
    /^data:([a-zA-Z0-9!#$&^_.+/-]+);base64,([\s\S]+)$/,
  );
  if (!dataUrlMatch) {
    return { ok: false, error: 'Invalid image data URL format' };
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(dataUrlMatch[2], 'base64');
  } catch {
    return { ok: false, error: 'Invalid base64 in image data URL' };
  }
  const sigCheck = validateImageSignature(decoded);
  if (!sigCheck.isValid) {
    return { ok: false, error: sigCheck.error ?? 'Invalid image content' };
  }
  return { ok: true, storage: rawData };
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const filename: string = searchParams.get('filename') as string;
  const filetype: string = searchParams.get('filetype') ?? 'file';
  const rawMimeType: string | null = searchParams.get('mime');
  // Reject malformed or oversized MIME up front. An attacker controls this
  // query param, and it ends up on the blob's Content-Type header; we don't
  // want it carrying script tags or arbitrary bytes.
  if (rawMimeType && !isValidMimeType(rawMimeType)) {
    return badRequestResponse('Invalid MIME type');
  }
  const mimeType: string | null = rawMimeType;

  if (!filename) {
    return badRequestResponse('Filename is required');
  }

  if (filetype) {
    const validation = validateFileNotExecutable(filename, mimeType);
    if (!validation.isValid) {
      return badRequestResponse(validation.error!);
    }
  }

  const ctx: UploadContext = {
    filename,
    filetype,
    mimeType,
    isImage:
      (mimeType && mimeType.startsWith('image/')) || filetype === 'image',
  };

  // Hoist session to outer scope so catch block can reuse it
  // (avoids redundant auth() call on error)
  let session: Session | null = null;

  try {
    session = await auth();
    if (!session) {
      return errorResponse('Unauthorized', 401);
    }

    // Advisory early rejection from Content-Length — cheap and pre-buffer.
    // The authoritative check happens via `readBoundedBody` below.
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      const declaredSize = parseInt(contentLength, 10);
      if (Number.isInteger(declaredSize) && declaredSize >= 0) {
        const earlyCheck = validateFileSizeRaw(
          filename,
          declaredSize,
          mimeType ?? undefined,
        );
        if (!earlyCheck.valid) {
          return payloadTooLargeResponse(earlyCheck.error ?? 'File too large');
        }
      }
    }

    const contentTypeHeader = request.headers.get('content-type') || '';
    const isMultipart = contentTypeHeader.includes('multipart/form-data');

    const category = getFileCategory(filename, mimeType ?? undefined);
    const buffered = await readBoundedBody(
      request,
      computeStreamCap(category, isMultipart),
    );
    if (buffered === null) {
      return payloadTooLargeResponse('Request body exceeds file size limit');
    }

    let fileData: Buffer | string;

    if (isMultipart) {
      // Re-parse the bounded ArrayBuffer as multipart. Passing the
      // ArrayBuffer directly to Response avoids an extra full-body copy
      // through `new Uint8Array(buffer)`, which matters for documents at
      // the 50MB cap and especially for video at 1.5GB.
      const parsed = new Response(buffered, {
        headers: { 'content-type': contentTypeHeader },
      });
      const formData = await parsed.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return badRequestResponse('No file provided in form data');
      }
      fileData = Buffer.from(await file.arrayBuffer());
    } else {
      // Legacy base64 upload (backward compatibility). Buffer.from(arrayBuffer)
      // is zero-copy; we only need the materialization to decode UTF-8.
      const rawData = Buffer.from(buffered).toString('utf8');

      if (ctx.isImage) {
        const result = validateLegacyImageDataUrl(rawData);
        if (!result.ok) return badRequestResponse(result.error);
        fileData = result.storage;
      } else {
        try {
          fileData = Buffer.from(rawData, 'base64');
        } catch (decodeError) {
          console.error('[FileUploadRoute] base64 decode failed:', decodeError);
          return badRequestResponse(
            'Invalid file data format - expected base64 encoding',
          );
        }
      }
    }

    // Authoritative size check on the actual buffered content.
    const fileSize = Buffer.isBuffer(fileData)
      ? fileData.length
      : Buffer.byteLength(fileData);
    const sizeValidation = validateFileSizeRaw(
      filename,
      fileSize,
      mimeType ?? undefined,
    );
    if (!sizeValidation.valid) {
      return payloadTooLargeResponse(sizeValidation.error ?? 'File too large');
    }

    const startTime = Date.now();
    const stored = await storeFile(fileData, ctx, session);
    if (!stored.ok) {
      return badRequestResponse(stored.error);
    }
    const duration = Date.now() - startTime;

    // Log successful file upload (fire-and-forget)
    const logger = getAzureMonitorLogger();
    void logger.logFileSuccess({
      user: session.user,
      filename,
      fileSize,
      fileType: mimeType || filetype,
      duration,
    });

    // Return a reference path instead of the full blob URL
    const blobFilename = stored.uri.split('/').pop();
    return successResponse(
      { uri: `/api/file/${blobFilename}` },
      'File uploaded successfully',
    );
  } catch (error) {
    console.error('[FileUploadRoute] Error uploading file:', error);

    // Log file upload error (fire-and-forget) using hoisted session.
    // If the error occurred before auth() completed, session is null and we
    // skip logging — pre-auth errors are rare validation failures.
    if (session) {
      const logger = getAzureMonitorLogger();
      void logger.logFileError({
        user: session.user,
        filename,
        fileType: mimeType || filetype,
        errorCode: 'FILE_UPLOAD_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return errorResponse(
      'Failed to upload file',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
