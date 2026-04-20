/**
 * Chunked Transcription Service
 *
 * Handles transcription of large audio files (>25MB) by:
 * 1. Splitting the audio into smaller chunks using FFmpeg
 * 2. Transcribing chunks in parallel (with concurrency limit) using the Whisper API
 * 3. Combining the results with chunk markers, maintaining correct order
 *
 * This replaces the unreliable Azure Batch Transcription service
 * with a more reliable chunked approach using the same Whisper API
 * that works for small files.
 */
import {
  cleanupChunks,
  isAudioSplittingAvailable,
  splitAudioFile,
} from '@/lib/utils/server/audio/audioSplitter';

import {
  TranscriptionError,
  TranscriptionErrorClass,
  TranscriptionOptions,
} from '@/types/transcription';

import {
  ChunkedJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  updateProgress,
} from './chunkedJobStore';
import { WhisperTranscriptionService } from './whisperTranscriptionService';

import { v4 as uuidv4 } from 'uuid';

/**
 * Number of chunks to process in parallel. Tunable at deploy time via
 * TRANSCRIPTION_CONCURRENCY — higher if your Whisper deployment has more
 * throughput, lower if you're hitting 429s.
 */
const MAX_CONCURRENT_CHUNKS = Math.max(
  1,
  Number(process.env.TRANSCRIPTION_CONCURRENCY) || 3,
);

/**
 * Total attempts per chunk (1 initial call + additional retries on transient
 * failure). Tunable via TRANSCRIPTION_RETRIES, which expresses *retries* for
 * legacy compatibility; the loop uses ATTEMPTS = retries + 1.
 */
const TRANSCRIPTION_RETRIES = Math.max(
  0,
  Number(process.env.TRANSCRIPTION_RETRIES) || 2,
);
const MAX_CHUNK_ATTEMPTS = TRANSCRIPTION_RETRIES + 1;

/** Delay before retry after failure (ms) */
const RETRY_DELAY_MS = 2000;

export interface ChunkedTranscriptionOptions extends TranscriptionOptions {
  /** Called when progress is updated */
  onProgress?: (completed: number, total: number) => void;
}

export interface ChunkedJobStartResult {
  /** Unique job identifier for polling */
  jobId: string;
  /** Total number of chunks to process */
  totalChunks: number;
}

/** Result of transcribing a single chunk */
interface ChunkResult {
  /** Original index of the chunk (for ordering) */
  index: number;
  /** Transcribed text */
  transcript: string;
}

/**
 * Service for transcribing large audio files using chunked processing.
 */
export class ChunkedTranscriptionService {
  private whisperService: WhisperTranscriptionService;

  constructor() {
    this.whisperService = new WhisperTranscriptionService();
  }

  /**
   * Checks if chunked transcription is available.
   * Requires FFmpeg and FFprobe for audio splitting.
   */
  isAvailable(): boolean {
    return isAudioSplittingAvailable();
  }

  /**
   * Starts an async chunked transcription job.
   *
   * Returns immediately with job ID; processing continues in background.
   * Use getStatus() or the status API to poll for progress.
   *
   * @param audioPath - Path to the audio file to transcribe
   * @param filename - Original filename for display
   * @param userId - ID of the user who owns this job (for authorization)
   * @param options - Transcription options (language, etc.)
   * @returns Job ID and total chunk count
   */
  async startJob(
    audioPath: string,
    filename: string,
    userId: string,
    options?: ChunkedTranscriptionOptions,
  ): Promise<ChunkedJobStartResult> {
    // Verify FFmpeg is available
    if (!this.isAvailable()) {
      throw new Error(
        'Chunked transcription is not available. FFmpeg/FFprobe not found.',
      );
    }

    // Generate the jobId first so chunk files can live in a per-job
    // subdir — makes cleanup atomic (rm-rf the subdir) and prevents parallel
    // jobs from interleaving their chunk files.
    const jobId = uuidv4();

    // Split the audio file into chunks
    console.log(
      `[ChunkedTranscription] Splitting audio file for job ${jobId}: ${audioPath}`,
    );
    const splitResult = await splitAudioFile(audioPath, {
      targetChunkSizeBytes: 20 * 1024 * 1024, // 20MB chunks
      outputFormat: 'mp3',
      jobId,
    });

    const { chunkPaths, chunkCount, totalDurationSecs, chunkDurationSecs } =
      splitResult;

    console.log(
      `[ChunkedTranscription] Created job ${jobId}: ${chunkCount} chunks ` +
        `(~${chunkDurationSecs}s each, ${totalDurationSecs.toFixed(0)}s total)`,
    );

    // Create job in store
    createJob(jobId, userId, chunkCount, chunkPaths, filename, audioPath);

    // Start async processing (don't await - runs in background)
    this.processChunksAsync(jobId, chunkPaths, filename, options).catch(
      (error) => {
        console.error(
          `[ChunkedTranscription] Background processing error for ${jobId}:`,
          error,
        );
        try {
          const errorClass = (error as TranscriptionError)?.errorClass;
          failJob(jobId, error.message || 'Unknown error', errorClass);
        } catch (failError) {
          console.error(
            `[ChunkedTranscription] Could not mark job ${jobId} failed:`,
            failError,
          );
        }
      },
    );

    return {
      jobId,
      totalChunks: chunkCount,
    };
  }

  /**
   * Gets the current status of a job.
   *
   * @param jobId - Job identifier
   * @returns Job status, or undefined if not found
   */
  getStatus(jobId: string): ChunkedJob | undefined {
    return getJob(jobId);
  }

  /**
   * Processes chunks asynchronously in the background using parallel batches.
   *
   * This method is called without await from startJob() and runs
   * independently, updating the job store as it progresses.
   *
   * Chunks are processed in parallel batches of MAX_CONCURRENT_CHUNKS,
   * but results are sorted by index to maintain original order.
   */
  private async processChunksAsync(
    jobId: string,
    chunkPaths: string[],
    filename: string,
    options?: ChunkedTranscriptionOptions,
  ): Promise<void> {
    const totalChunks = chunkPaths.length;
    const results: ChunkResult[] = [];

    console.log(
      `[ChunkedTranscription] Starting parallel processing for job ${jobId} ` +
        `(${totalChunks} chunks, max ${MAX_CONCURRENT_CHUNKS} concurrent)`,
    );

    try {
      // Process chunks in parallel batches
      for (
        let batchStart = 0;
        batchStart < totalChunks;
        batchStart += MAX_CONCURRENT_CHUNKS
      ) {
        // Cooperative cancel check between batches — if the user cancelled
        // or the job was externally terminated, stop burning Whisper calls.
        const current = getJob(jobId);
        if (!current || current.status === 'cancelled') {
          console.log(
            `[ChunkedTranscription] Job ${jobId} cancelled; aborting remaining chunks`,
          );
          return;
        }

        const batchEnd = Math.min(
          batchStart + MAX_CONCURRENT_CHUNKS,
          totalChunks,
        );
        const batchChunkPaths = chunkPaths.slice(batchStart, batchEnd);

        console.log(
          `[ChunkedTranscription] Processing batch: chunks ${batchStart + 1}-${batchEnd} of ${totalChunks}`,
        );

        // Update progress at batch start
        updateProgress(jobId, results.length, batchStart);

        // Process this batch in parallel
        const batchPromises = batchChunkPaths.map(
          async (chunkPath, batchIndex) => {
            const globalIndex = batchStart + batchIndex;
            const chunkNum = globalIndex + 1;

            console.log(
              `[ChunkedTranscription] Transcribing chunk ${chunkNum}/${totalChunks}: ${chunkPath}`,
            );

            const transcript = await this.transcribeChunkWithRetry(
              chunkPath,
              chunkNum,
              totalChunks,
              options,
            );

            return { index: globalIndex, transcript };
          },
        );

        // Wait for all chunks in this batch to complete
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Update progress after batch completes
        updateProgress(jobId, results.length, batchEnd - 1);

        // Call progress callback if provided
        options?.onProgress?.(results.length, totalChunks);
      }

      // Sort by index to ensure correct order (parallel results may arrive out of order)
      results.sort((a, b) => a.index - b.index);
      const transcripts = results.map((r) => r.transcript);

      // Combine transcripts with chunk markers
      const combinedTranscript = this.combineTranscripts(
        transcripts,
        totalChunks,
      );

      // Mark job as complete
      completeJob(jobId, combinedTranscript);

      console.log(
        `[ChunkedTranscription] Job ${jobId} completed: ${combinedTranscript.length} chars`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errorClass = (error as TranscriptionError)?.errorClass;
      console.error(
        `[ChunkedTranscription] Job ${jobId} failed (${errorClass ?? 'unclassified'}):`,
        errorMessage,
      );
      failJob(jobId, errorMessage, errorClass);
      throw error;
    } finally {
      // Always clean up chunk files
      console.log(`[ChunkedTranscription] Cleaning up chunks for job ${jobId}`);
      await cleanupChunks(chunkPaths);
    }
  }

  /**
   * Transcribes a single chunk with retry logic that respects error class.
   *
   * - `permanent`: don't retry (user error — bad codec, oversized, etc.).
   * - `auth`: rebuild the Whisper client once (handles token expiry on long jobs)
   *           and retry.
   * - `rate_limit`: retry with doubled backoff.
   * - `transient` / `unknown`: retry with normal backoff.
   */
  private async transcribeChunkWithRetry(
    chunkPath: string,
    chunkNum: number,
    totalChunks: number,
    options?: TranscriptionOptions,
  ): Promise<string> {
    let lastError: Error = new Error('Unknown chunk transcription error');

    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES + 1; attempt++) {
      try {
        const transcript = await this.whisperService.transcribe(
          chunkPath,
          options,
        );
        return transcript;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const errorClass: TranscriptionErrorClass =
          (lastError as TranscriptionError).errorClass ?? 'unknown';

        if (errorClass === 'permanent') {
          // User-visible error (bad codec, oversize, etc.); don't waste retries.
          throw lastError;
        }

        if (attempt > MAX_CHUNK_RETRIES) break;

        if (errorClass === 'auth') {
          // Token likely expired during a long job — rebuild the client.
          console.warn(
            `[ChunkedTranscription] Chunk ${chunkNum}/${totalChunks} hit auth error; re-initializing Whisper client`,
          );
          this.whisperService = new WhisperTranscriptionService();
          await delay(RETRY_DELAY_MS);
          continue;
        }

        const waitTime =
          errorClass === 'rate_limit' ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;

        console.warn(
          `[ChunkedTranscription] Chunk ${chunkNum}/${totalChunks} failed (${errorClass}, ` +
            `attempt ${attempt}/${MAX_CHUNK_RETRIES + 1}), retrying in ${waitTime}ms...`,
        );

        await delay(waitTime);
      }
    }

    const err = new Error(
      `Failed to transcribe chunk ${chunkNum}/${totalChunks} after ${MAX_CHUNK_RETRIES + 1} attempts: ${lastError.message}`,
    ) as TranscriptionError;
    err.errorClass = (lastError as TranscriptionError).errorClass ?? 'unknown';
    throw err;
  }

  /**
   * Combines individual chunk transcripts into a single transcript.
   *
   * For multiple chunks, adds markers to show where each chunk begins.
   * For a single chunk, returns the transcript without markers.
   */
  private combineTranscripts(
    transcripts: string[],
    totalChunks: number,
  ): string {
    if (totalChunks === 1) {
      // Single chunk - no markers needed
      return transcripts[0] || '';
    }

    // Multiple chunks - add markers for transparency. If a chunk was silent
    // and came back empty, emit a placeholder so users don't read an empty
    // marker as "the system broke" — they can see that transcription ran
    // and deliberately found no speech in that segment.
    return transcripts
      .map((text, i) => {
        const chunkNum = i + 1;
        const trimmedText = text.trim();
        const body =
          trimmedText.length > 0
            ? trimmedText
            : '(no speech detected in this segment)';
        return `[Chunk ${chunkNum}/${totalChunks}]\n${body}`;
      })
      .join('\n\n');
  }
}

/**
 * Helper function to create a delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Singleton instance for convenience.
 */
let chunkedServiceInstance: ChunkedTranscriptionService | null = null;

/**
 * Gets the singleton chunked transcription service instance.
 */
export function getChunkedTranscriptionService(): ChunkedTranscriptionService {
  if (!chunkedServiceInstance) {
    chunkedServiceInstance = new ChunkedTranscriptionService();
  }
  return chunkedServiceInstance;
}
