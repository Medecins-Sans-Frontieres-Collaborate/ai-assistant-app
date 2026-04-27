import toast from 'react-hot-toast';

import { cacheImageBase64 } from '@/lib/services/imageService';

import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import {
  finalizeChunkedUploadAction,
  initChunkedUploadAction,
  uploadChunkAction,
  uploadFileAction,
} from '@/lib/actions/fileUpload';
import {
  DISALLOWED_EXTENSIONS,
  DISALLOWED_MIME_TYPES,
} from '@/lib/constants/disallowedFileTypes';
import {
  getMaxSizeForFile,
  validateFileSize,
} from '@/lib/constants/fileLimits';

// Threshold for using Server Action (files larger than 10MB use Server Action)
const SERVER_ACTION_THRESHOLD = 10 * 1024 * 1024; // 10MB

// Chunked upload configuration
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per chunk
const CHUNK_CONCURRENCY = 4; // Parallel in-flight chunk uploads
/**
 * Total attempts per chunk (1 initial call + additional retries on transient
 * failure). Mirrors the `MAX_CHUNK_ATTEMPTS` naming used in
 * chunkedTranscriptionService so both chunked pipelines speak the same vocab.
 */
const MAX_CHUNK_ATTEMPTS = 3;

export interface UploadProgress {
  [fileName: string]: number;
}

export interface UploadResult {
  url: string;
  originalFilename: string;
  type: 'image' | 'file' | 'audio' | 'video';
}

export class FileUploadService {
  /**
   * Check if file type is allowed
   */
  static isFileAllowed(file: File): boolean {
    const extension =
      '.' + file.name.split('.')[file.name.split('.').length - 1].toLowerCase();
    return (
      !DISALLOWED_EXTENSIONS.includes(extension) &&
      !DISALLOWED_MIME_TYPES.includes(file.type)
    );
  }

  /**
   * Check if file is audio or video
   */
  static isAudioOrVideo(file: File): boolean {
    return file.type.startsWith('audio/') || file.type.startsWith('video/');
  }

  /**
   * Check if file is an image
   */
  static isImage(file: File): boolean {
    return file.type.startsWith('image/');
  }

  /**
   * Get file type category
   */
  static getFileType(file: File): 'image' | 'audio' | 'video' | 'file' {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.startsWith('video/')) return 'video';
    return 'file';
  }

  /**
   * Check if file is a video (not just audio)
   */
  static isVideo(file: File): boolean {
    return file.type.startsWith('video/');
  }

  /**
   * Get max file size for given file type.
   * Uses centralized limits from lib/constants/fileLimits.ts.
   */
  static getMaxSize(file: File): { bytes: number; display: string } {
    return getMaxSizeForFile(file);
  }

  /**
   * Validate file before upload.
   * Checks file type allowlist and size limits.
   */
  static validateFile(file: File): { valid: boolean; error?: string } {
    // Check if file type is allowed
    if (!this.isFileAllowed(file)) {
      return {
        valid: false,
        error: `Invalid file type: ${file.name}`,
      };
    }

    // Validate file size using centralized limits
    const sizeValidation = validateFileSize(file);
    if (!sizeValidation.valid) {
      return {
        valid: false,
        error: sizeValidation.error,
      };
    }

    return { valid: true };
  }

  /**
   * Read file as base64 data URL
   */
  static readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Upload image file via multipart/form-data, matching the file upload
   * transport. Sending raw base64 strings as the request body (the previous
   * approach) was unreliable in some Chrome+Windows environments — likely
   * mangled by corporate proxies that don't expect multi-MB plain-text bodies.
   */
  static async uploadImage(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<UploadResult> {
    const result = await this.uploadFileViaXHR(file, onProgress, 'image');

    // Best-effort: warm the in-memory base64 cache so the first chat send in
    // this session can skip the /api/file/{id} refetch. Failures must not
    // fail the upload.
    try {
      if (result.url) {
        const dataUrl = await this.readFileAsDataURL(file);
        cacheImageBase64(result.url, dataUrl);
      }
    } catch (cacheError) {
      console.warn('Failed to cache image:', cacheError);
    }

    return result;
  }

  /**
   * Upload file using FormData with XMLHttpRequest for progress tracking.
   * Uses native binary upload to avoid base64 encoding corruption issues.
   *
   * For files larger than 10MB, uses Server Action to bypass Route Handler
   * body size limits. Server Actions support up to 1.6GB (configured in next.config.js).
   *
   * @param file - The file to upload
   * @param onProgress - Optional progress callback (0-100)
   * @returns Upload result with URL and metadata
   */
  static async uploadFile(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<UploadResult> {
    // Use Server Action for large files to bypass Route Handler body size limit
    if (file.size > SERVER_ACTION_THRESHOLD) {
      return this.uploadFileViaServerAction(file, onProgress);
    }

    // Use XHR for smaller files (better progress tracking)
    return this.uploadFileViaXHR(file, onProgress);
  }

  /**
   * Upload file via Server Action (supports up to 1.6GB).
   * Uses chunked upload for better progress tracking on large files.
   */
  private static async uploadFileViaServerAction(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<UploadResult> {
    // Use chunked upload for large files to get real progress
    return this.uploadFileChunked(file, onProgress);
  }

  /**
   * Upload a file using chunked upload for real progress tracking.
   * Splits the file into chunks, uploads each via Server Action,
   * and reports progress after each chunk completes.
   *
   * @param file - The file to upload
   * @param onProgress - Optional progress callback (0-100)
   * @returns Upload result with URL and metadata
   */
  private static async uploadFileChunked(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<UploadResult> {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Initialize chunked upload session
    if (onProgress) onProgress(2);

    const initResult = await initChunkedUploadAction({
      filename: file.name,
      filetype: this.getFileType(file),
      mimeType: file.type,
      totalSize: file.size,
      chunkSize: CHUNK_SIZE,
    });

    if (!initResult.success || !initResult.session) {
      throw new Error(
        initResult.error || `Failed to initialize upload for ${file.name}`,
      );
    }

    const session = initResult.session;
    if (onProgress) onProgress(5);

    // 2. Upload chunks in parallel via a bounded worker pool.
    //
    // Azure block staging is unordered — `commitBlockList` assembles the blob
    // in the caller-provided block-id order, not the order blocks were staged.
    // So parallel `stageBlock` calls are safe, and fewer serialized round
    // trips means less per-chunk overhead (proxy, Server Action, auth, RTT).
    let nextIndex = 0;
    let completedChunks = 0;
    let firstError: Error | null = null;

    const worker = async (): Promise<void> => {
      while (firstError === null) {
        const i = nextIndex++;
        if (i >= totalChunks) return;

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const chunkResult = await this.uploadChunkWithRetry(chunk, session, i);

        if (!chunkResult.success) {
          if (firstError === null) {
            firstError = new Error(
              chunkResult.error ||
                `Failed to upload chunk ${i + 1} of ${totalChunks}`,
            );
          }
          return;
        }

        completedChunks++;
        if (onProgress) {
          const progressPercent =
            5 + Math.round((completedChunks / totalChunks) * 90);
          onProgress(progressPercent);
        }
      }
    };

    const workerCount = Math.min(CHUNK_CONCURRENCY, totalChunks);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (firstError) {
      throw firstError;
    }

    // 3. Finalize the upload (commit all blocks)
    const finalResult = await finalizeChunkedUploadAction(session);

    if (!finalResult.success || !finalResult.uri) {
      throw new Error(
        finalResult.error || `Failed to finalize upload for ${file.name}`,
      );
    }

    if (onProgress) onProgress(100);

    return {
      url: finalResult.uri,
      originalFilename: file.name,
      type: this.getFileType(file),
    };
  }

  /**
   * Upload a single chunk with retry logic.
   * Retries up to MAX_CHUNK_RETRIES times with exponential backoff.
   *
   * @param chunk - The chunk blob to upload
   * @param session - The chunked upload session
   * @param chunkIndex - Zero-based index of this chunk
   * @returns Chunk upload result
   */
  private static async uploadChunkWithRetry(
    chunk: Blob,
    session: ChunkedUploadSession,
    chunkIndex: number,
  ): Promise<{ success: boolean; error?: string }> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
      const chunkData = new FormData();
      chunkData.append('chunk', chunk);

      const result = await uploadChunkAction(session, chunkIndex, chunkData);

      if (result.success) {
        return { success: true };
      }

      lastError = result.error;

      // Exponential backoff between retries: 1s, 2s, …
      if (attempt < MAX_CHUNK_ATTEMPTS - 1) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await this.delay(delayMs);
      }
    }

    return {
      success: false,
      error: lastError || `Chunk failed after ${MAX_CHUNK_ATTEMPTS} attempts`,
    };
  }

  /**
   * Helper to delay execution for retry logic.
   */
  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Upload file via XMLHttpRequest (supports progress tracking).
   * Used for smaller files that fit within Route Handler body size limits.
   */
  private static uploadFileViaXHR(
    file: File,
    onProgress?: (progress: number) => void,
    filetype: 'file' | 'image' = 'file',
  ): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);

      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress((e.loaded / e.total) * 100);
        }
      });

      // Handle successful completion
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            const resp = data.data || data;
            resolve({
              url: resp.uri ?? resp.filename ?? '',
              originalFilename: file.name,
              type: this.getFileType(file),
            });
          } catch (parseError) {
            reject(new Error(`Failed to parse upload response: ${file.name}`));
          }
        } else {
          reject(
            new Error(
              `File upload failed: ${file.name} - ${xhr.status} ${xhr.statusText}`,
            ),
          );
        }
      });

      // Handle network errors
      xhr.addEventListener('error', () =>
        reject(new Error(`Upload failed: ${file.name}`)),
      );
      xhr.addEventListener('abort', () =>
        reject(new Error(`Upload aborted: ${file.name}`)),
      );

      // Build URL with query parameters
      const encodedFileName = encodeURIComponent(file.name);
      const encodedMimeType = encodeURIComponent(file.type);
      const url = `/api/file/upload?filename=${encodedFileName}&filetype=${filetype}&mime=${encodedMimeType}`;

      xhr.open('POST', url);
      xhr.send(formData);
    });
  }

  /**
   * Upload single file with automatic type detection
   */
  static async uploadSingleFile(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<UploadResult> {
    const validation = this.validateFile(file);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    if (this.isImage(file)) {
      return this.uploadImage(file, onProgress);
    } else {
      return this.uploadFile(file, onProgress);
    }
  }

  /**
   * Upload multiple files
   */
  static async uploadMultipleFiles(
    files: File[],
    onProgressUpdate?: (progress: UploadProgress) => void,
  ): Promise<UploadResult[]> {
    const results: UploadResult[] = [];
    const progressMap: UploadProgress = {};

    // Initialize progress for all files
    files.forEach((file) => {
      progressMap[file.name] = 0;
    });

    for (const file of files) {
      try {
        const result = await this.uploadSingleFile(file, (progress) => {
          progressMap[file.name] = progress;
          if (onProgressUpdate) {
            onProgressUpdate({ ...progressMap });
          }
        });
        results.push(result);
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error);
        toast.error(
          error instanceof Error
            ? error.message
            : `Failed to upload ${file.name}`,
        );
      }
    }

    return results;
  }
}
