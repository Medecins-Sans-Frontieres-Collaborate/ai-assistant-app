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
import {
  getContentType,
  validateBufferSignature,
  validateFileNotExecutable,
} from '@/lib/utils/server/file/mimeTypes';

import { auth } from '@/auth';
import {
  getFileCategory,
  getFileSizeLimit,
  validateFileSizeRaw,
} from '@/lib/constants/fileLimits';

/**
 * Buffers the request body into a `Buffer` and rejects when the size exceeds
 * `maxBytes`. The body is consumed via `arrayBuffer()` (undici-internal
 * consumption) rather than a manual reader to avoid races with the test
 * environment's synthetic body source. The size check still runs before
 * `formData()` parses fields and allocates `File` objects, so an oversized
 * payload is rejected before the expensive multipart parse.
 *
 * Returns null when the cap is exceeded; the caller should respond 413.
 */
async function readBoundedBody(
  request: NextRequest,
  maxBytes: number,
): Promise<Buffer | null> {
  const arrayBuffer = await request.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) return null;
  return Buffer.from(arrayBuffer);
}

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
 * Verifies that a buffer begins with a known image format's magic bytes.
 * The audio/video signature validator (`validateBufferSignature`) doesn't
 * cover image formats, so we maintain a small inline list here. Without
 * this, an attacker could send arbitrary binary content under an image
 * filename and `filetype=image` and we'd store it without any content check.
 */
function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // GIF87a / GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }
  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return true;
  }
  return false;
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

  // Validate file is not executable
  if (filetype) {
    const validation = validateFileNotExecutable(filename, mimeType);
    if (!validation.isValid) {
      return badRequestResponse(validation.error!);
    }
  }

  /**
   * Uploads file data to blob storage with content-based naming.
   *
   * @param data - The file data as Buffer (binary) or string (base64/image data URL)
   * @param session - User session for authentication
   * @returns The blob storage URL
   */
  const uploadFileToBlobStorage = async (
    data: Buffer | string,
    session: Session,
  ) => {
    const userId = getUserIdFromSession(session);
    const blobStorageClient: BlobStorage = createBlobStorageClient(session);

    // Hash data directly - Hasher accepts both Buffer and string
    // For buffers, this avoids base64 string length limit for large files
    const hashedFileContents = Hasher.sha256(data);
    const extension: string | undefined = filename.split('.').pop();

    let contentType;
    if (mimeType) {
      contentType = mimeType;
    } else if (extension) {
      contentType = getContentType(extension);
    } else {
      contentType = 'application/octet-stream';
    }

    const uploadLocation = filetype === 'image' ? 'images' : 'files';

    // Validate magic bytes for audio/video files to prevent spoofing
    const isAudioVideo =
      (mimeType &&
        (mimeType.startsWith('audio/') || mimeType.startsWith('video/'))) ||
      filetype === 'audio' ||
      filetype === 'video';

    if (isAudioVideo && Buffer.isBuffer(data)) {
      const signatureValidation = validateBufferSignature(
        data,
        'any',
        filename,
      );
      if (!signatureValidation.isValid) {
        throw new Error(
          signatureValidation.error ||
            'File content does not match expected audio/video format',
        );
      }
    }

    // Image content check. The audio/video validator doesn't cover images,
    // and without this the route would accept arbitrary binary content
    // under an image filename + `filetype=image`. Buffer-only path: the
    // legacy text body may still be a base64 data URL string for very old
    // clients during deploy — those are checked at decode time below.
    const isImage =
      (mimeType && mimeType.startsWith('image/')) || filetype === 'image';
    if (isImage && Buffer.isBuffer(data) && !looksLikeImage(data)) {
      throw new Error('File content does not match a recognized image format');
    }

    return await blobStorageClient.upload(
      `${userId}/uploads/${uploadLocation}/${hashedFileContents}.${extension}`,
      data,
      {
        blobHTTPHeaders: {
          blobContentType: contentType,
        },
      },
    );
  };

  // Hoist session to outer scope so catch block can reuse it
  // (avoids redundant auth() call on error)
  let session: Session | null = null;

  try {
    session = await auth();
    if (!session) {
      return errorResponse('Unauthorized', 401);
    }

    // Compute the per-category cap. We add a small margin to allow for
    // multipart envelope overhead (boundaries, Content-Disposition headers).
    // The base64 path adds ~33% overhead — bound that path against the
    // base64-equivalent of the cap.
    const category = getFileCategory(filename, mimeType ?? undefined);
    const rawCap = getFileSizeLimit(category);
    const MULTIPART_OVERHEAD_BYTES = 4 * 1024;

    // Advisory early rejection from Content-Length. Cheap and pre-buffer.
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

    // Check Content-Type to determine upload format
    const contentTypeHeader = request.headers.get('content-type') || '';
    const isMultipart = contentTypeHeader.includes('multipart/form-data');

    // Authoritative streaming bound: if Content-Length lied (or was absent)
    // and the body actually exceeds the cap, we stop reading and reject
    // before `formData()` or `text()` buffer the full payload into memory.
    // Use a slightly higher cap for multipart due to envelope overhead and
    // ~33% larger for the base64 text path.
    const streamCap = isMultipart
      ? rawCap + MULTIPART_OVERHEAD_BYTES
      : Math.ceil(rawCap * 1.4) + MULTIPART_OVERHEAD_BYTES;

    const buffered = await readBoundedBody(request, streamCap);
    if (buffered === null) {
      return payloadTooLargeResponse('Request body exceeds file size limit');
    }

    let fileData: Buffer | string;

    if (isMultipart) {
      // Re-parse the bounded buffer as multipart. Response accepts a
      // Uint8Array body (Buffer at runtime is a Uint8Array, but TS narrows
      // BodyInit more strictly) and inherits the Content-Type with boundary.
      const parsed = new Response(new Uint8Array(buffered), {
        headers: { 'content-type': contentTypeHeader },
      });
      const formData = await parsed.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return badRequestResponse('No file provided in form data');
      }
      fileData = Buffer.from(await file.arrayBuffer());
    } else {
      // Legacy base64 upload (backward compatibility)
      const rawData = buffered.toString('utf8');
      const isImage =
        (mimeType && mimeType.startsWith('image/')) || filetype === 'image';

      if (isImage) {
        // Decode the base64 data URL so we can run the image content check
        // before storing. Without this decode, this branch would skip
        // signature validation entirely and store any string the client sent.
        // Storage shape is preserved (the data URL string) for backward
        // compat with existing blobs that getBlobBase64String reads via its
        // data:-prefix branch.
        const dataUrlMatch = rawData.match(
          /^data:([a-zA-Z0-9!#$&^_.+/-]+);base64,([\s\S]+)$/,
        );
        if (!dataUrlMatch) {
          return badRequestResponse('Invalid image data URL format');
        }
        let decoded: Buffer;
        try {
          decoded = Buffer.from(dataUrlMatch[2], 'base64');
        } catch {
          return badRequestResponse('Invalid base64 in image data URL');
        }
        if (!looksLikeImage(decoded)) {
          return badRequestResponse(
            'File content does not match a recognized image format',
          );
        }
        fileData = rawData;
      } else {
        // Decode base64 to binary for non-image files
        try {
          fileData = Buffer.from(rawData, 'base64');
        } catch (decodeError) {
          console.error('Error decoding file data:', decodeError);
          return badRequestResponse(
            'Invalid file data format - expected base64 encoding',
          );
        }
      }
    }

    // Check file size using category-based limits
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
    const fileURI: string = await uploadFileToBlobStorage(fileData, session);
    const duration = Date.now() - startTime;

    // Log successful file upload (fire-and-forget)
    const logger = getAzureMonitorLogger();
    void logger.logFileSuccess({
      user: session.user,
      filename: filename,
      fileSize: fileSize,
      fileType: mimeType || filetype,
      duration,
    });

    // Return a reference path instead of the full blob URL
    const blobFilename = fileURI.split('/').pop();
    return successResponse(
      { uri: `/api/file/${blobFilename}` },
      'File uploaded successfully',
    );
  } catch (error) {
    console.error('Error uploading file:', error);

    // Log file upload error (fire-and-forget) using hoisted session
    // Note: If error occurred before auth() completed, session will be null
    // and we skip logging (pre-auth errors are rare validation failures)
    if (session) {
      const logger = getAzureMonitorLogger();
      void logger.logFileError({
        user: session.user,
        filename: filename,
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
