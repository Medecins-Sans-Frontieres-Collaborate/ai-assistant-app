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
 * Marker error thrown by the size-bounding TransformStream when the body
 * exceeds the cap. Caught by the caller which converts it to a 413 response.
 */
const PAYLOAD_TOO_LARGE = Symbol('PAYLOAD_TOO_LARGE');

/**
 * Pipes the request body through a size-bounded TransformStream and reads
 * the result into a Buffer. The transform errors the stream as soon as the
 * byte count exceeds `maxBytes`, so a lying Content-Length cannot push
 * arbitrary bytes into `formData()` memory.
 *
 * Returns null when the cap is tripped; the caller should respond 413.
 */
async function readBoundedBody(
  request: NextRequest,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);

  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(PAYLOAD_TOO_LARGE);
        return;
      }
      controller.enqueue(chunk);
    },
  });

  try {
    const bounded = request.body.pipeThrough(limiter);
    const arrayBuffer = await new Response(bounded).arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error === PAYLOAD_TOO_LARGE) return null;
    throw error;
  }
}

/**
 * Route segment config to allow large file uploads.
 * Next.js App Router defaults to 1MB body size limit.
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
 */
export const maxDuration = 60; // Allow up to 60 seconds for large uploads

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const filename: string = searchParams.get('filename') as string;
  const filetype: string = searchParams.get('filetype') ?? 'file';
  const mimeType: string | null = searchParams.get('mime');

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
        // Images are stored as base64 data URL strings
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
