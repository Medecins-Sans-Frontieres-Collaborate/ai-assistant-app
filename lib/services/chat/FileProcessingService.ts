import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { retryAsync } from '@/lib/utils/app/retry';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob';

import fs from 'fs';

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
    const session: Session = { user, expires: '' } as Session;
    const userId = getUserIdFromSession(session);
    const remoteFilepath = `${userId}/uploads/files`;
    const id: string | undefined = fileUrl.split('/').pop();

    if (!id) throw new Error(`Could not find file id from URL: ${fileUrl}`);

    const blobStorage = createBlobStorageClient(session);
    const blob: Buffer = await (blobStorage.get(
      `${remoteFilepath}/${id}`,
      BlobProperty.BLOB,
    ) as Promise<Buffer>);

    // Write file with secure permissions (0o600 = read/write for owner only)
    await fs.promises.writeFile(filePath, new Uint8Array(blob), {
      mode: 0o600,
    });
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
   *
   * @param fileUrl - The blob storage URL
   * @returns Tuple of [blobId, filePath]
   */
  getTempFilePath(fileUrl: string): [string, string] {
    const blobId = fileUrl.split('/').pop();
    if (!blobId) throw new Error('Could not parse blob ID from URL!');

    return [blobId, `/tmp/${blobId}`];
  }
}
