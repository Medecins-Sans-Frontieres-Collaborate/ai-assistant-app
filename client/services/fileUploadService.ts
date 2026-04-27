import toast from 'react-hot-toast';

import { cacheImageBase64 } from '@/lib/services/imageService';

import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import {
  cancelChunkedUploadAction,
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
 * Total attempts per chunk (initial + retries). Mirrors the naming used in
 * chunkedTranscriptionService so both chunked pipelines speak the same vocab.
 */
const CHUNK_TOTAL_ATTEMPTS = 3;

/**
 * Per-request XHR timeout in ms. Long enough for a single 10MB chunk on a
 * slow cellular connection (~80s at 1 Mbps), with margin for proxy delay.
 * A stalled connection beyond this is almost certainly broken — better to
 * fail fast and let the retry loop try again.
 */
const XHR_TIMEOUT_MS = 120_000;

/** Total attempts for the small-file XHR path (initial + retries). */
const XHR_TOTAL_ATTEMPTS = 3;

/**
 * Upload error carrying a transience hint. Permanent errors (4xx) skip the
 * retry loop; transient errors (network, timeout, 5xx) are eligible for
 * retry with backoff.
 */
class UploadError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

class UploadAbortedError extends Error {
  constructor(filename: string) {
    super(`Upload cancelled: ${filename}`);
    this.name = 'UploadAbortedError';
  }
}

/**
 * Returns the jittered exponential-backoff delay (in ms) for a given retry
 * attempt. Capped at 8s base; jitter is the standard 0.5–1.0× multiplier to
 * desynchronize clients recovering from a shared outage.
 */
function jitteredBackoffMs(attempt: number): number {
  const base = Math.min(8_000, Math.pow(2, attempt) * 500);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/** Sleep for the jittered backoff appropriate to this retry attempt. */
function sleepBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, jitteredBackoffMs(attempt)),
  );
}

/**
 * Retry an async operation with jittered backoff between attempts.
 *
 * Honors an optional `signal` (throws `UploadAbortedError(filename)` between
 * attempts when aborted) and a `shouldRetry` classifier that decides whether
 * a thrown error is eligible for retry. The loop always either returns the
 * operation's result or throws the last error.
 */
async function withClientRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts: {
    totalAttempts: number;
    shouldRetry: (error: unknown) => boolean;
    signal?: AbortSignal;
    abortFilename: string;
  },
): Promise<T> {
  for (let attempt = 0; attempt < opts.totalAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new UploadAbortedError(opts.abortFilename);
    }
    try {
      return await operation(attempt);
    } catch (error) {
      if (error instanceof UploadAbortedError) throw error;
      const isLastAttempt = attempt === opts.totalAttempts - 1;
      if (isLastAttempt || !opts.shouldRetry(error)) throw error;
      await sleepBackoff(attempt);
    }
  }
  // Unreachable: the loop above either returns or throws on every attempt.
  throw new Error(`withClientRetry: exhausted ${opts.totalAttempts} attempts`);
}

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
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    // Best-effort base64 read for the in-memory cache, run in parallel with
    // the upload — neither depends on the other. The cache lets the first
    // chat send in this session skip the /api/file/{id} refetch. A failure
    // here must not fail the upload.
    const [result, dataUrl] = await Promise.all([
      this.uploadXhrWithRetry(file, onProgress, 'image', signal),
      this.readFileAsDataURL(file).catch((cacheError) => {
        console.warn(
          '[FileUploadService] Failed to read image for cache:',
          cacheError,
        );
        return null;
      }),
    ]);

    if (result.url && dataUrl) {
      cacheImageBase64(result.url, dataUrl);
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
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    // Use Server Action for large files to bypass Route Handler body size limit
    if (file.size > SERVER_ACTION_THRESHOLD) {
      return this.uploadFileViaServerAction(file, onProgress, signal);
    }

    // Use XHR for smaller files (better progress tracking)
    return this.uploadXhrWithRetry(file, onProgress, 'file', signal);
  }

  /**
   * Upload file via Server Action (supports up to 1.6GB).
   * Uses chunked upload for better progress tracking on large files.
   */
  private static async uploadFileViaServerAction(
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    // Use chunked upload for large files to get real progress
    return this.uploadFileChunked(file, onProgress, signal);
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
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    if (signal?.aborted) throw new UploadAbortedError(file.name);

    const session = await this.initChunkedSession(file, onProgress);

    const uploadError = await this.uploadAllChunks(
      file,
      session,
      onProgress,
      signal,
    );

    if (uploadError) {
      // Best-effort fire-and-forget: release any committed-blob remnants.
      // Uncommitted blocks are GC'd by Azure after 7 days, so the user
      // shouldn't have to wait on a network round-trip just to see the
      // error toast. We log on rejection but don't block the throw.
      void cancelChunkedUploadAction(session).catch((cancelErr) =>
        console.warn(
          `[FileUploadService] Failed to cancel chunked upload for ${file.name}:`,
          cancelErr,
        ),
      );
      throw uploadError;
    }

    return this.commitChunkedUpload(file, session, onProgress);
  }

  /**
   * Phase 1: ask the server to provision a chunked-upload session.
   * Reports 2% progress (init) → 5% (ready for chunks).
   */
  private static async initChunkedSession(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<ChunkedUploadSession> {
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
    if (onProgress) onProgress(5);
    return initResult.session;
  }

  /**
   * Phase 2: upload chunks in parallel via a bounded worker pool. Returns
   * the first error encountered, or null on success.
   *
   * Azure block staging is unordered — `commitBlockList` assembles the blob
   * in the caller-provided block-id order, not the order blocks were
   * staged. So parallel `stageBlock` calls are safe, and fewer serialized
   * round trips means less per-chunk overhead (proxy, Server Action, auth,
   * RTT).
   */
  private static async uploadAllChunks(
    file: File,
    session: ChunkedUploadSession,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<Error | null> {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let nextIndex = 0;
    let completedChunks = 0;
    let firstError: Error | null = null;

    const worker = async (): Promise<void> => {
      while (firstError === null) {
        if (signal?.aborted) {
          if (firstError === null) {
            firstError = new UploadAbortedError(file.name);
          }
          return;
        }
        const i = nextIndex++;
        if (i >= totalChunks) return;

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const chunkResult = await this.uploadChunkWithRetry(
          chunk,
          session,
          i,
          signal,
        );

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
          onProgress(5 + Math.round((completedChunks / totalChunks) * 90));
        }
      }
    };

    const workerCount = Math.min(CHUNK_CONCURRENCY, totalChunks);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return firstError;
  }

  /**
   * Phase 3: ask the server to commit all staged blocks into the final blob.
   * Reports 100% on success.
   */
  private static async commitChunkedUpload(
    file: File,
    session: ChunkedUploadSession,
    onProgress?: (progress: number) => void,
  ): Promise<UploadResult> {
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
   * Upload a single chunk with retry logic. Retries every error (the chunked
   * Server Action returns errors as data rather than throwing, so we don't
   * have transience classification at this layer — the inner Azure SDK call
   * is wrapped in `withAzureRetry` server-side which already filters 5xx vs
   * 4xx).
   */
  private static async uploadChunkWithRetry(
    chunk: Blob,
    session: ChunkedUploadSession,
    chunkIndex: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      return await withClientRetry(
        async () => {
          const chunkData = new FormData();
          chunkData.append('chunk', chunk);
          const result = await uploadChunkAction(
            session,
            chunkIndex,
            chunkData,
          );
          if (!result.success) {
            // Throw so withClientRetry can decide whether to retry.
            throw new Error(result.error || 'chunk upload failed');
          }
          return { success: true as const };
        },
        {
          totalAttempts: CHUNK_TOTAL_ATTEMPTS,
          shouldRetry: () => true,
          signal,
          abortFilename: `chunk ${chunkIndex}`,
        },
      );
    } catch (error) {
      if (error instanceof UploadAbortedError) {
        return { success: false, error: 'cancelled' };
      }
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : `Chunk failed after ${CHUNK_TOTAL_ATTEMPTS} attempts`,
      };
    }
  }

  /**
   * Retry wrapper around the small-file XHR path. Retries network errors,
   * timeouts, and 5xx responses with jittered backoff. Does NOT retry 4xx
   * responses (validation, auth, content blocked) — those won't resolve by
   * trying again. Honors an optional AbortSignal at every attempt boundary.
   */
  private static uploadXhrWithRetry(
    file: File,
    onProgress?: (progress: number) => void,
    filetype: 'file' | 'image' = 'file',
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    return withClientRetry(
      () => this.uploadFileViaXHR(file, onProgress, filetype, signal),
      {
        totalAttempts: XHR_TOTAL_ATTEMPTS,
        shouldRetry: (error) => error instanceof UploadError && error.transient,
        signal,
        abortFilename: file.name,
      },
    );
  }

  /**
   * Upload file via XMLHttpRequest (supports progress tracking).
   * Used for smaller files that fit within Route Handler body size limits.
   *
   * Throws `UploadError` (with transience hint) on HTTP/network failures and
   * `UploadAbortedError` when the caller's signal is aborted. Wrapped by
   * `uploadXhrWithRetry`.
   */
  private static uploadFileViaXHR(
    file: File,
    onProgress?: (progress: number) => void,
    filetype: 'file' | 'image' = 'file',
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new UploadAbortedError(file.name));
        return;
      }

      const xhr = new XMLHttpRequest();
      // Without a timeout, a stalled proxy or stuck connection hangs forever.
      xhr.timeout = XHR_TIMEOUT_MS;

      const formData = new FormData();
      formData.append('file', file);

      const onAbort = () => {
        try {
          xhr.abort();
        } catch {
          /* ignore — abort on a finished XHR is a noop in spec */
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress((e.loaded / e.total) * 100);
        }
      });

      xhr.addEventListener('load', () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            const resp = data.data || data;
            resolve({
              url: resp.uri ?? resp.filename ?? '',
              originalFilename: file.name,
              type: this.getFileType(file),
            });
          } catch {
            // 2xx with unparseable body is almost always a proxy/WAF
            // returning HTML at status 200. Treat as transient.
            reject(
              new UploadError(
                `Failed to parse upload response: ${file.name}`,
                true,
                xhr.status,
              ),
            );
          }
        } else {
          // 5xx → transient (server hiccup); 4xx → permanent (won't fix
          // itself); other (e.g. status 0) → transient.
          const transient = xhr.status === 0 || xhr.status >= 500;
          reject(
            new UploadError(
              `File upload failed: ${file.name} - ${xhr.status} ${xhr.statusText}`,
              transient,
              xhr.status,
            ),
          );
        }
      });

      xhr.addEventListener('error', () => {
        cleanup();
        reject(new UploadError(`Upload failed: ${file.name}`, true));
      });
      xhr.addEventListener('timeout', () => {
        cleanup();
        reject(new UploadError(`Upload timed out: ${file.name}`, true));
      });
      xhr.addEventListener('abort', () => {
        cleanup();
        // Distinguish caller-initiated abort from other abort sources
        // (browser cancellation, refresh) — both surface here.
        reject(
          signal?.aborted
            ? new UploadAbortedError(file.name)
            : new UploadError(`Upload aborted: ${file.name}`, true),
        );
      });

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
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    const validation = this.validateFile(file);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    if (this.isImage(file)) {
      return this.uploadImage(file, onProgress, signal);
    } else {
      return this.uploadFile(file, onProgress, signal);
    }
  }

  /**
   * Upload multiple files. The optional `signal` aborts the in-flight upload
   * and prevents subsequent files in the batch from starting.
   */
  static async uploadMultipleFiles(
    files: File[],
    onProgressUpdate?: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult[]> {
    const results: UploadResult[] = [];
    const progressMap: UploadProgress = {};

    // Initialize progress for all files
    files.forEach((file) => {
      progressMap[file.name] = 0;
    });

    for (const file of files) {
      if (signal?.aborted) break;
      try {
        const result = await this.uploadSingleFile(
          file,
          (progress) => {
            progressMap[file.name] = progress;
            if (onProgressUpdate) {
              onProgressUpdate({ ...progressMap });
            }
          },
          signal,
        );
        results.push(result);
      } catch (error) {
        if (error instanceof UploadAbortedError) {
          // User-initiated cancel — silent, the UI already removed the file.
          continue;
        }
        console.error(
          `[FileUploadService] Failed to upload ${file.name}:`,
          error,
        );
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
