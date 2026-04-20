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

import { TranscriptionOptions } from '@/types/transcription';

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

/** Maximum number of chunks to process in parallel */
const MAX_CONCURRENT_CHUNKS = 3;

/** Maximum retries for a single chunk */
const MAX_CHUNK_RETRIES = 2;

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

    // Split the audio file into chunks
    console.log(`[ChunkedTranscription] Splitting audio file: ${audioPath}`);
    const splitResult = await splitAudioFile(audioPath, {
      targetChunkSizeBytes: 20 * 1024 * 1024, // 20MB chunks
      outputFormat: 'mp3',
    });

    const jobId = uuidv4();
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
          failJob(jobId, error.message || 'Unknown error');
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
      console.error(
        `[ChunkedTranscription] Job ${jobId} failed:`,
        errorMessage,
      );
      failJob(jobId, errorMessage);
      throw error;
    } finally {
      // Always clean up chunk files
      console.log(`[ChunkedTranscription] Cleaning up chunks for job ${jobId}`);
      await cleanupChunks(chunkPaths);
    }
  }

  /**
   * Transcribes a single chunk with retry logic.
   */
  private async transcribeChunkWithRetry(
    chunkPath: string,
    chunkNum: number,
    totalChunks: number,
    options?: TranscriptionOptions,
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES + 1; attempt++) {
      try {
        const transcript = await this.whisperService.transcribe(
          chunkPath,
          options,
        );
        return transcript;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's a rate limit error
        const isRateLimit =
          lastError.message.includes('rate limit') ||
          lastError.message.includes('capacity') ||
          lastError.message.includes('429');

        if (attempt <= MAX_CHUNK_RETRIES) {
          const waitTime = isRateLimit ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;

          console.warn(
            `[ChunkedTranscription] Chunk ${chunkNum}/${totalChunks} failed ` +
              `(attempt ${attempt}/${MAX_CHUNK_RETRIES + 1}), retrying in ${waitTime}ms...`,
          );

          await delay(waitTime);
        }
      }
    }

    throw new Error(
      `Failed to transcribe chunk ${chunkNum}/${totalChunks} after ${MAX_CHUNK_RETRIES + 1} attempts: ${lastError?.message}`,
    );
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

    // Multiple chunks - add markers for transparency
    return transcripts
      .map((text, i) => {
        const chunkNum = i + 1;
        const trimmedText = text.trim();
        return `[Chunk ${chunkNum}/${totalChunks}]\n${trimmedText}`;
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
