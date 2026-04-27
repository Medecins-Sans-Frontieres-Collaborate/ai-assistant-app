'use server';

import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  AzureBlobStorage,
  BlobProperty,
  BlobStorage,
} from '@/lib/utils/server/blob/blob';
import { loadDocument } from '@/lib/utils/server/file/fileHandling';
import { validateImageSignature } from '@/lib/utils/server/file/imageSignature';
import {
  getContentType,
  validateBufferSignature,
  validateFileNotExecutable,
} from '@/lib/utils/server/file/mimeTypes';
import {
  getCachedTextPath,
  shouldCacheText,
} from '@/lib/utils/server/file/textCacheUtils';
import {
  MAX_CHUNK_SIZE_BYTES,
  MAX_TOTAL_CHUNKS,
  MAX_TOTAL_SIZE_BYTES,
  signChunkedSession,
  verifyChunkedSession,
} from '@/lib/utils/server/upload/chunkedSessionSigning';

import type {
  ChunkUploadResult,
  ChunkedUploadSession,
  FinalizeUploadResult,
  InitChunkedUploadParams,
} from '@/lib/types/chunkedUpload';

import { auth } from '@/auth';
import { validateFileSizeRaw } from '@/lib/constants/fileLimits';
import { v4 as uuidv4 } from 'uuid';

/**
 * Extracts text from a document and uploads it as a cached plain-text file.
 * Runs as fire-and-forget; failures are logged but do not affect the upload.
 *
 * @param blobPath - The blob storage path of the original file
 * @param data - The file contents as a Buffer
 * @param filename - The original filename (used for MIME type detection)
 * @param session - The authenticated user session
 */
async function extractAndCacheText(
  blobPath: string,
  data: Buffer,
  filename: string,
  session: Session,
): Promise<void> {
  try {
    // Convert Buffer to Uint8Array for File constructor compatibility
    const uint8Array = new Uint8Array(data);
    const file = new File([uint8Array], filename);
    const text = await loadDocument(file);

    if (!text?.trim()) {
      console.warn(`[TextCache] Empty text extracted from: ${filename}`);
      return;
    }

    const blobStorage = createBlobStorageClient(session);
    await blobStorage.upload(getCachedTextPath(blobPath), text, {
      blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
    });

    console.log(
      `[TextCache] Cached text for ${filename} (${text.length} chars)`,
    );
  } catch (error) {
    console.error(`[TextCache] Failed to cache text for ${filename}:`, error);
  }
}

/**
 * Result of a file upload operation.
 */
export interface UploadResult {
  success: boolean;
  uri?: string;
  error?: string;
}

/**
 * Server Action to upload files to blob storage.
 *
 * This action supports up to 1.6GB body size limit configured in next.config.js,
 * unlike Route Handlers which have a lower default limit.
 * File size limits vary by file type (image: 5MB, audio: 1GB, video: 1.5GB, document: 50MB).
 *
 * @param formData - FormData containing:
 *   - file: The file to upload
 *   - filename: Original filename
 *   - filetype: 'image' | 'file' | 'audio' | 'video'
 *   - mime: MIME type (optional)
 * @returns Upload result with URI or error message
 */
export async function uploadFileAction(
  formData: FormData,
): Promise<UploadResult> {
  try {
    // Authenticate user
    const session: Session | null = await auth();
    if (!session) {
      return { success: false, error: 'Unauthorized' };
    }

    // Extract form data
    const file = formData.get('file') as File | null;
    const filename = formData.get('filename') as string | null;
    const filetype = (formData.get('filetype') as string) ?? 'file';
    const mimeType = formData.get('mime') as string | null;

    if (!file) {
      return { success: false, error: 'No file provided' };
    }

    if (!filename) {
      return { success: false, error: 'Filename is required' };
    }

    // Validate file is not executable
    const executableValidation = validateFileNotExecutable(filename, mimeType);
    if (!executableValidation.isValid) {
      return { success: false, error: executableValidation.error };
    }

    // Early rejection: check declared size before buffering the file.
    // This is advisory only — the authoritative check runs against actual
    // buffer length at the validateFileSizeRaw call below, so a false
    // 'size' value cannot bypass validation.
    const declaredSize = formData.get('size');
    if (declaredSize) {
      const parsed = parseInt(declaredSize as string, 10);
      if (!isNaN(parsed)) {
        const earlyCheck = validateFileSizeRaw(
          filename,
          parsed,
          mimeType ?? undefined,
        );
        if (!earlyCheck.valid) {
          return { success: false, error: earlyCheck.error };
        }
      }
    }

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const fileData = Buffer.from(arrayBuffer);

    // Check file size using category-based limits
    const sizeValidation = validateFileSizeRaw(
      filename,
      fileData.length,
      mimeType ?? undefined,
    );
    if (!sizeValidation.valid) {
      return {
        success: false,
        error: sizeValidation.error,
      };
    }

    // Upload to blob storage
    const fileURI = await uploadFileToBlobStorage(
      fileData,
      filename,
      filetype,
      mimeType,
      session,
    );

    return { success: true, uri: fileURI };
  } catch (error) {
    console.error('[uploadFileAction] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload file',
    };
  }
}

/**
 * Upload file data to blob storage with content-based naming.
 */
async function uploadFileToBlobStorage(
  data: Buffer,
  filename: string,
  filetype: string,
  mimeType: string | null,
  session: Session,
): Promise<string> {
  const userId = getUserIdFromSession(session);
  const blobStorageClient: BlobStorage = createBlobStorageClient(session);

  // Hash buffer directly - avoids base64 string length limit for large files
  const hashedFileContents = Hasher.sha256(data);
  const extension: string | undefined = filename.split('.').pop();

  // Determine content type
  let contentType: string;
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

  if (isAudioVideo) {
    const signatureValidation = validateBufferSignature(data, 'any', filename);
    if (!signatureValidation.isValid) {
      throw new Error(
        signatureValidation.error ||
          'File content does not match expected audio/video format',
      );
    }
  }

  // Image content check — parity with the route handler so this entrypoint
  // can't accept arbitrary binary under filetype=image.
  const isImage =
    (mimeType && mimeType.startsWith('image/')) || filetype === 'image';
  if (isImage) {
    const imageSig = validateImageSignature(data);
    if (!imageSig.isValid) {
      throw new Error(imageSig.error ?? 'Invalid image content');
    }
  }

  const blobPath = `${userId}/uploads/${uploadLocation}/${hashedFileContents}.${extension}`;

  const url = await blobStorageClient.upload(blobPath, data, {
    blobHTTPHeaders: {
      blobContentType: contentType,
    },
  });

  // Fire-and-forget text extraction for cacheable file types
  if (shouldCacheText(filename)) {
    void extractAndCacheText(blobPath, data, filename, session);
  }

  return url;
}

/**
 * Initialize a chunked upload session.
 *
 * Validates the file and creates a session with upload metadata.
 * The session is used for subsequent chunk uploads and finalization.
 *
 * @param params - Upload initialization parameters
 * @returns Chunked upload session or error
 */
export async function initChunkedUploadAction(
  params: InitChunkedUploadParams,
): Promise<{
  success: boolean;
  session?: ChunkedUploadSession;
  error?: string;
}> {
  try {
    const session = await auth();
    if (!session) {
      return { success: false, error: 'Unauthorized' };
    }

    const { filename, filetype, mimeType, totalSize, chunkSize } = params;

    // Validate file is not executable
    const executableValidation = validateFileNotExecutable(filename, mimeType);
    if (!executableValidation.isValid) {
      return { success: false, error: executableValidation.error };
    }

    // Absolute bounds independent of the category-based size check below, so
    // a pathological chunkSize/totalSize can't slip through a future refactor.
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      return { success: false, error: 'Invalid chunk size' };
    }
    if (chunkSize > MAX_CHUNK_SIZE_BYTES) {
      return { success: false, error: 'Chunk size exceeds maximum' };
    }
    if (!Number.isInteger(totalSize) || totalSize < 0) {
      return { success: false, error: 'Invalid total size' };
    }
    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
      return { success: false, error: 'Total size exceeds maximum' };
    }

    // Validate file size using category-based limits
    const sizeValidation = validateFileSizeRaw(filename, totalSize, mimeType);
    if (!sizeValidation.valid) {
      return { success: false, error: sizeValidation.error };
    }

    const userId = getUserIdFromSession(session);
    const uploadId = uuidv4();
    const extension = filename.split('.').pop() || '';
    const uploadLocation = filetype === 'image' ? 'images' : 'files';

    // Generate a unique blob path using uploadId (content hash not available until all chunks received)
    const blobPath = `${userId}/uploads/${uploadLocation}/${uploadId}.${extension}`;

    const totalChunks = Math.ceil(totalSize / chunkSize);
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      return { success: false, error: 'Too many chunks for this upload' };
    }

    const unsignedSession: ChunkedUploadSession = {
      uploadId,
      filename,
      filetype,
      mimeType,
      totalSize,
      totalChunks,
      chunkSize,
      blobPath,
    };

    const uploadSession = signChunkedSession(unsignedSession, userId);

    return { success: true, session: uploadSession };
  } catch (error) {
    console.error('[initChunkedUploadAction] Error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to initialize upload',
    };
  }
}

/**
 * Generate a base64-encoded block ID from a chunk index.
 * Block IDs must be consistent length and base64 encoded.
 *
 * @param chunkIndex - Zero-based chunk index
 * @returns Base64-encoded block ID
 */
function generateBlockId(chunkIndex: number): string {
  // Pad index to 6 digits for consistent length (supports up to 999,999 chunks)
  const paddedIndex = chunkIndex.toString().padStart(6, '0');
  return Buffer.from(paddedIndex).toString('base64');
}

/**
 * Upload a single chunk of a file.
 *
 * Stages the chunk using Azure Block Blob API. The chunk is identified
 * by a block ID derived from its index.
 *
 * @param session - The chunked upload session
 * @param chunkIndex - Zero-based index of this chunk
 * @param chunkData - FormData containing the chunk in a 'chunk' field
 * @returns Result indicating success or failure
 */
export async function uploadChunkAction(
  session: ChunkedUploadSession,
  chunkIndex: number,
  chunkData: FormData,
): Promise<ChunkUploadResult> {
  try {
    const authSession = await auth();
    if (!authSession) {
      return { success: false, chunkIndex, error: 'Unauthorized' };
    }

    const authedUserId = getUserIdFromSession(authSession);
    const verification = verifyChunkedSession(session, authedUserId);
    if (!verification.valid) {
      return { success: false, chunkIndex, error: verification.reason };
    }

    // Reject chunks beyond the expected range
    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      return {
        success: false,
        chunkIndex,
        error: `Chunk index ${chunkIndex} is out of range (expected 0-${session.totalChunks - 1})`,
      };
    }

    const chunk = chunkData.get('chunk') as Blob | null;
    if (!chunk) {
      return { success: false, chunkIndex, error: 'No chunk data provided' };
    }

    // Convert chunk to buffer
    const arrayBuffer = await chunk.arrayBuffer();
    const chunkBuffer = Buffer.from(arrayBuffer);

    // Reject oversized chunks to prevent cumulative size abuse. We enforce
    // BOTH the per-session chunkSize (within a small tolerance for the last
    // chunk) AND the absolute cap, since the HMAC guarantees chunkSize is
    // what the server set at init — but a future bug in signing shouldn't
    // unlock unbounded growth.
    const expectedMaxChunkSize = session.chunkSize + 1024;
    if (
      chunkBuffer.length > expectedMaxChunkSize ||
      chunkBuffer.length > MAX_CHUNK_SIZE_BYTES
    ) {
      return {
        success: false,
        chunkIndex,
        error: `Chunk size ${chunkBuffer.length} exceeds expected maximum ${expectedMaxChunkSize}`,
      };
    }

    // Get blob storage client
    const blobStorageClient = createBlobStorageClient(authSession);

    // Ensure we have the AzureBlobStorage methods
    if (!(blobStorageClient instanceof AzureBlobStorage)) {
      return {
        success: false,
        chunkIndex,
        error: 'Chunked upload requires Azure Blob Storage',
      };
    }

    // Generate block ID for this chunk
    const blockId = generateBlockId(chunkIndex);

    // Stage the block
    await blobStorageClient.stageBlock(session.blobPath, blockId, chunkBuffer);

    return { success: true, chunkIndex, blockId };
  } catch (error) {
    console.error(
      `[uploadChunkAction] Error uploading chunk ${chunkIndex}:`,
      error,
    );
    return {
      success: false,
      chunkIndex,
      error: error instanceof Error ? error.message : 'Failed to upload chunk',
    };
  }
}

/**
 * Finalize a chunked upload by committing all staged blocks.
 *
 * Calls Azure Block Blob API to commit the block list, forming the final blob.
 *
 * @param session - The chunked upload session
 * @returns Result with final blob URI or error
 */
export async function finalizeChunkedUploadAction(
  session: ChunkedUploadSession,
): Promise<FinalizeUploadResult> {
  try {
    const authSession = await auth();
    if (!authSession) {
      return { success: false, error: 'Unauthorized' };
    }

    const authedUserId = getUserIdFromSession(authSession);
    const verification = verifyChunkedSession(session, authedUserId);
    if (!verification.valid) {
      return { success: false, error: verification.reason };
    }

    // Get blob storage client
    const blobStorageClient = createBlobStorageClient(authSession);

    // Ensure we have the AzureBlobStorage methods
    if (!(blobStorageClient instanceof AzureBlobStorage)) {
      return {
        success: false,
        error: 'Chunked upload requires Azure Blob Storage',
      };
    }

    // Generate block IDs in order
    const blockIds: string[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      blockIds.push(generateBlockId(i));
    }

    // Determine content type
    let contentType = session.mimeType;
    if (!contentType) {
      const extension = session.filename.split('.').pop() || '';
      contentType = getContentType(extension);
    }

    // Commit the block list. On failure, best-effort cleanup so any
    // partially-committed blob is removed; uncommitted blocks fall to
    // Azure's 7-day GC.
    let uri: string;
    try {
      uri = await blobStorageClient.commitBlockList(
        session.blobPath,
        blockIds,
        {
          blobHTTPHeaders: {
            blobContentType: contentType,
          },
        },
      );
    } catch (commitError) {
      try {
        await blobStorageClient.deleteIfExists(session.blobPath);
      } catch (cleanupError) {
        console.error(
          '[finalizeChunkedUploadAction] cleanup after commit failure threw:',
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
      }
      throw commitError;
    }

    // Fire-and-forget: download committed blob and cache text
    if (shouldCacheText(session.filename)) {
      void (async () => {
        try {
          const blob = (await blobStorageClient.get(
            session.blobPath,
            BlobProperty.BLOB,
          )) as Buffer;
          await extractAndCacheText(
            session.blobPath,
            blob,
            session.filename,
            authSession,
          );
        } catch (error) {
          console.error(
            '[TextCache] Chunked upload cache failed:',
            error instanceof Error ? error.message : error,
          );
        }
      })();
    }

    return { success: true, uri };
  } catch (error) {
    console.error('[finalizeChunkedUploadAction] Error:', error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to finalize upload',
    };
  }
}

/**
 * Cancel a chunked upload session and best-effort delete any committed blob
 * at the session's blobPath. Uncommitted staged blocks are garbage collected
 * by Azure after 7 days, so a failure here is recoverable.
 *
 * Refuses to cancel a session whose blob has already been finalized (i.e.
 * `commitBlockList` ran and the blob is now visible). Without this guard, a
 * UI cancel button that survives finalize completion could destroy the
 * user's just-uploaded file. Pre-finalize blobs only have uncommitted
 * blocks, which Azure does not surface via `blobExists`.
 *
 * Idempotent — safe to call multiple times for the same session.
 */
export async function cancelChunkedUploadAction(
  session: ChunkedUploadSession,
): Promise<{ success: boolean; error?: string }> {
  try {
    const authSession = await auth();
    if (!authSession) {
      return { success: false, error: 'Unauthorized' };
    }

    const authedUserId = getUserIdFromSession(authSession);
    const verification = verifyChunkedSession(session, authedUserId);
    if (!verification.valid) {
      return { success: false, error: verification.reason };
    }

    const blobStorageClient = createBlobStorageClient(authSession);
    if (!(blobStorageClient instanceof AzureBlobStorage)) {
      return {
        success: false,
        error: 'Chunked upload requires Azure Blob Storage',
      };
    }

    if (await blobStorageClient.blobExists(session.blobPath)) {
      // The blob exists as a committed blob — finalize already ran. Refuse
      // to delete a successfully-uploaded file.
      return {
        success: false,
        error: 'Upload already finalized; cancel is no longer applicable',
      };
    }

    // No committed blob exists; uncommitted blocks (if any) fall to Azure's
    // 7-day GC. The deleteIfExists call is a no-op in the typical case and
    // a safety-net otherwise.
    await blobStorageClient.deleteIfExists(session.blobPath);
    return { success: true };
  } catch (error) {
    console.error('[cancelChunkedUploadAction] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel upload',
    };
  }
}
