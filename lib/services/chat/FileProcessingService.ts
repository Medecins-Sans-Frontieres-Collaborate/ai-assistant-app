import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { retryAsync } from '@/lib/utils/app/retry';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';
import { getCachedTextPath } from '@/lib/utils/server/file/textCacheUtils';

import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

/**
 * Result of downloading a file with cache preference.
 */
export interface DownloadResult {
  /** True if the cached plain-text version was used */
  usedCache: boolean;
}

/**
 * Service for file processing operations.
 * Handles file download, reading, and preparation for analysis.
 *
 * Extracted to allow composition in multiple handlers:
 * - FileConversationHandler (file-only conversations)
 * - MixedContentHandler (file + image conversations)
 */
export class FileProcessingService {
  /**
   * Gets the file size from blob storage without downloading it.
   * Used for validation to prevent OOM on large files.
   *
   * @param fileUrl - The blob storage URL of the file
   * @param user - User session for authentication
   * @returns File size in bytes
   */
  async getFileSize(fileUrl: string, user: Session['user']): Promise<number> {
    const session: Session = { user, expires: '' } as Session;
    const userId = getUserIdFromSession(session);
    const remoteFilepath = `${userId}/uploads/files`;
    const id: string | undefined = fileUrl.split('/').pop();

    if (!id) throw new Error(`Could not find file id from URL: ${fileUrl}`);

    const blobStorage = createBlobStorageClient(session);
    return await blobStorage.getBlobSize(`${remoteFilepath}/${id}`);
  }

  /**
   * Downloads a file from blob storage to local filesystem.
   *
   * @param fileUrl - The blob storage URL of the file
   * @param filePath - Local path where file should be saved
   * @param user - User session for authentication
   */
  async downloadFile(
    fileUrl: string,
    filePath: string,
    user: Session['user'],
  ): Promise<void> {
    const perfStart = performance.now();
    const session: Session = { user, expires: '' } as Session;
    const userId = getUserIdFromSession(session);
    const remoteFilepath = `${userId}/uploads/files`;
    const id: string | undefined = fileUrl.split('/').pop();

    if (!id) throw new Error(`Could not find file id from URL: ${fileUrl}`);

    const perfClientStart = performance.now();
    const blobStorage = createBlobStorageClient(session);
    console.log(
      `[Perf] FileProcessingService.createBlobStorageClient: ${(performance.now() - perfClientStart).toFixed(1)}ms`,
    );
    const perfBlobGetStart = performance.now();
    const blob: Buffer = await (blobStorage.get(
      `${remoteFilepath}/${id}`,
      BlobProperty.BLOB,
    ) as Promise<Buffer>);
    console.log(
      `[Perf] FileProcessingService.blobGet: ${(performance.now() - perfBlobGetStart).toFixed(1)}ms`,
    );

    // Write file with secure permissions (0o600 = read/write for owner only)
    const perfWriteStart = performance.now();
    await fs.promises.writeFile(filePath, new Uint8Array(blob), {
      mode: 0o600,
    });
    console.log(
      `[Perf] FileProcessingService.fsWriteFile: ${(performance.now() - perfWriteStart).toFixed(1)}ms`,
    );
    console.log(
      `[Perf] FileProcessingService.downloadFile total: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
  }

  /**
   * Downloads a file from blob storage, preferring the cached plain-text version if available.
   * Falls back to the original file if no cache exists.
   *
   * This optimization avoids expensive document conversions (PDF, DOCX, etc.) on every chat.
   * Text was extracted and cached during the original upload.
   *
   * @param fileUrl - The blob storage URL of the file
   * @param filePath - Local path where file should be saved
   * @param user - User session for authentication
   * @returns Result indicating whether the cached version was used
   */
  async downloadFilePreferCached(
    fileUrl: string,
    filePath: string,
    user: Session['user'],
  ): Promise<DownloadResult> {
    const perfStart = performance.now();
    const session: Session = { user, expires: '' } as Session;
    const userId = getUserIdFromSession(session);
    const id: string | undefined = fileUrl.split('/').pop();

    if (!id) throw new Error(`Could not find file id from URL: ${fileUrl}`);

    const blobPath = `${userId}/uploads/files/${id}`;
    const cachedPath = getCachedTextPath(blobPath);
    const blobStorage = createBlobStorageClient(session);

    // Try cached version first
    try {
      const perfExistsStart = performance.now();
      if (await blobStorage.blobExists(cachedPath)) {
        console.log(
          `[Perf] FileProcessingService.blobExists (cache check): ${(performance.now() - perfExistsStart).toFixed(1)}ms - hit`,
        );
        const cached = (await blobStorage.get(
          cachedPath,
          BlobProperty.BLOB,
        )) as Buffer;
        await fs.promises.writeFile(filePath, cached, { mode: 0o600 });
        // Sanitize id for logging to prevent log injection
        const safeId = id.replace(/[\r\n\t]/g, '');
        console.log(`[FileProcessingService] Using cached text: ${safeId}`);
        console.log(
          `[Perf] FileProcessingService.downloadFilePreferCached (cache hit): ${(performance.now() - perfStart).toFixed(1)}ms`,
        );
        return { usedCache: true };
      }
      console.log(
        `[Perf] FileProcessingService.blobExists (cache check): ${(performance.now() - perfExistsStart).toFixed(1)}ms - miss`,
      );
    } catch (error) {
      console.warn(
        `[FileProcessingService] Cache check failed, falling back:`,
        error instanceof Error ? error.message : error,
      );
    }

    // Fall back to original file
    const blob = (await blobStorage.get(blobPath, BlobProperty.BLOB)) as Buffer;
    await fs.promises.writeFile(filePath, new Uint8Array(blob), {
      mode: 0o600,
    });
    console.log(
      `[Perf] FileProcessingService.downloadFilePreferCached (cache miss): ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return { usedCache: false };
  }

  /**
   * Reads a file from filesystem with retry logic.
   *
   * @param filePath - Path to file to read
   * @param maxRetries - Number of retry attempts
   * @returns File contents as Buffer
   */
  async readFile(filePath: string, maxRetries: number = 2): Promise<Buffer> {
    return retryAsync(
      () => Promise.resolve(fs.readFileSync(filePath)),
      maxRetries,
      1000,
    );
  }

  /**
   * Cleans up a temporary file.
   *
   * @param filePath - Path to file to delete
   */
  async cleanupFile(filePath: string): Promise<void> {
    try {
      fs.unlinkSync(filePath);
    } catch (fileUnlinkError) {
      if (
        fileUnlinkError instanceof Error &&
        fileUnlinkError.message.startsWith(
          'ENOENT: no such file or directory, unlink',
        )
      ) {
        console.warn('File not found during cleanup, but this is acceptable.');
      } else {
        console.error('Error unlinking file:', fileUnlinkError);
      }
    }
  }

  /**
   * Generates a safe temporary file path using blob ID.
   * Includes sanitization to prevent path traversal attacks.
   *
   * @param fileUrl - The blob storage URL
   * @returns Tuple of [sanitizedBlobId, resolvedFilePath]
   * @throws Error if blobId is missing, contains unsafe characters, or results in path traversal
   */
  getTempFilePath(fileUrl: string): [string, string] {
    const blobId = fileUrl.split('/').pop();
    if (!blobId) throw new Error('Could not parse blob ID from URL!');

    // Sanitize: strip any path components (e.g., "../" attacks)
    const sanitized = path.basename(blobId);

    // Validate: only allow alphanumeric, hyphens, underscores, and dots
    // This matches expected SHA256 hex hashes plus common file extensions
    if (!/^[\w.-]+$/.test(sanitized)) {
      throw new Error('Invalid blob ID: contains unsafe characters');
    }

    const filePath = path.join('/tmp', sanitized);

    // Defense in depth: verify resolved path stays within /tmp/
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith('/tmp/')) {
      throw new Error('Path traversal detected');
    }

    return [sanitized, resolved];
  }
}
