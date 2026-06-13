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
 * Parses a non-negative integer env knob. Unlike `Number(x) || fallback`,
 * an explicit "0" is honored (the || idiom silently turned 0 back into the
 * fallback). Malformed, negative, or fractional values fall back with a
 * warning rather than poisoning the math downstream.
 */
function parseEnvInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    console.warn(
      `[ChunkedTranscription] Ignoring invalid ${name}="${raw}" (need integer >= ${min}); using ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Number of chunks to process in parallel. Tunable at deploy time via
 * TRANSCRIPTION_CONCURRENCY — higher if your Whisper deployment has more
 * throughput, lower if you're hitting 429s.
 */
const MAX_CONCURRENT_CHUNKS = parseEnvInt('TRANSCRIPTION_CONCURRENCY', 3, 1);

/**
 * Total attempts per chunk (1 initial call + additional retries on transient
 * failure). Tunable via TRANSCRIPTION_RETRIES, which expresses *retries* for
 * legacy compatibility; the loop uses ATTEMPTS = retries + 1. An explicit
 * TRANSCRIPTION_RETRIES=0 means "one attempt, no retries".
 */
const TRANSCRIPTION_RETRIES = parseEnvInt('TRANSCRIPTION_RETRIES', 2, 0);
const MAX_CHUNK_ATTEMPTS = TRANSCRIPTION_RETRIES + 1;

/** Base delay before the first retry (ms); doubles per attempt. */
const RETRY_BASE_DELAY_MS = 2000;
/** Ceiling for computed backoff (server Retry-After may exceed this). */
const RETRY_MAX_DELAY_MS = 30_000;

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
    createJob(jobId, userId, chunkCount, chunkPaths, filename);

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
   * Processes chunks asynchronously in the background using a worker pool.
   *
   * This method is called without await from startJob() and runs
   * independently, updating the job store as it progresses.
   *
   * MAX_CONCURRENT_CHUNKS workers pull the next unclaimed chunk as soon as
   * they finish their current one — unlike lockstep batches, one slow or
   * retrying chunk never idles the other slots. Results are sorted by index
   * at the end to restore playback order.
   *
   * Workers adapt cooperatively:
   * - before each chunk they re-check the job store, so a user cancel stops
   *   new work within one chunk;
   * - the first fatal chunk error sets an abort flag that stops the other
   *   workers from claiming new chunks (and aborts their in-flight retries).
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

    let nextIndex = 0;
    let cancelled = false;
    let fatalError: Error | null = null;

    const isJobCancelled = (): boolean => {
      const current = getJob(jobId);
      return !current || current.status === 'cancelled';
    };
    const shouldAbort = (): boolean => cancelled || fatalError !== null;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (shouldAbort()) return;

        const index = nextIndex++;
        if (index >= totalChunks) return;

        // Cooperative cancel check before claiming Whisper capacity.
        if (isJobCancelled()) {
          cancelled = true;
          return;
        }

        const chunkNum = index + 1;
        console.log(
          `[ChunkedTranscription] Transcribing chunk ${chunkNum}/${totalChunks}: ${chunkPaths[index]}`,
        );

        try {
          const transcript = await this.transcribeChunkWithRetry(
            chunkPaths[index],
            chunkNum,
            totalChunks,
            options,
            shouldAbort,
          );
          results.push({ index, transcript });
          // updateProgress no-ops once the job is terminal (e.g. cancelled
          // while this chunk was in flight), so this can't resurrect it.
          updateProgress(jobId, results.length, index);
          options?.onProgress?.(results.length, totalChunks);
        } catch (error) {
          if (!fatalError) {
            fatalError =
              error instanceof Error ? error : new Error(String(error));
          }
          return;
        }
      }
    };

    try {
      updateProgress(jobId, 0, 0);

      const workerCount = Math.min(MAX_CONCURRENT_CHUNKS, totalChunks);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (cancelled || isJobCancelled()) {
        console.log(
          `[ChunkedTranscription] Job ${jobId} cancelled; aborted remaining chunks`,
        );
        return;
      }

      if (fatalError) {
        throw fatalError;
      }

      // Sort by index to ensure correct order (parallel results arrive out of order)
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
   * - `rate_limit`: wait for the server's Retry-After when it sent one,
   *           otherwise exponential backoff at double weight.
   * - `transient` / `unknown`: exponential backoff with jitter.
   *
   * `shouldAbort` is checked before every attempt and after every backoff
   * sleep so a cancelled job (or a sibling worker's fatal error) stops the
   * retry sequence instead of burning the full schedule.
   */
  private async transcribeChunkWithRetry(
    chunkPath: string,
    chunkNum: number,
    totalChunks: number,
    options?: TranscriptionOptions,
    shouldAbort: () => boolean = () => false,
  ): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
      if (shouldAbort()) {
        throw (
          lastError ??
          Object.assign(
            new Error(
              `Transcription of chunk ${chunkNum}/${totalChunks} aborted`,
            ) as TranscriptionError,
            { errorClass: 'transient' as TranscriptionErrorClass },
          )
        );
      }

      try {
        const transcript = await this.whisperService.transcribeChunk(
          chunkPath,
          options,
        );
        return transcript;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const tagged = lastError as TranscriptionError;
        const errorClass: TranscriptionErrorClass =
          tagged.errorClass ?? 'unknown';

        if (errorClass === 'permanent') {
          // User-visible error (bad codec, oversize, etc.); don't waste retries.
          throw lastError;
        }

        if (attempt >= MAX_CHUNK_ATTEMPTS) break;

        if (errorClass === 'auth') {
          // Token likely expired during a long job — rebuild the client.
          console.warn(
            `[ChunkedTranscription] Chunk ${chunkNum}/${totalChunks} hit auth error; re-initializing Whisper client`,
          );
          this.whisperService = new WhisperTranscriptionService();
        }

        const waitTime = computeBackoffMs(
          attempt,
          errorClass,
          tagged.retryAfterSeconds,
        );

        console.warn(
          `[ChunkedTranscription] Chunk ${chunkNum}/${totalChunks} failed (${errorClass}, ` +
            `attempt ${attempt}/${MAX_CHUNK_ATTEMPTS}), retrying in ${waitTime}ms...`,
        );

        await delay(waitTime);
      }
    }

    // `lastError` is always assigned on any iteration that takes the catch
    // branch, and the loop runs at least once (MAX_CHUNK_ATTEMPTS ≥ 1 since
    // parseEnvInt enforces TRANSCRIPTION_RETRIES ≥ 0). If the loop returns
    // successfully on the first try we never reach here.
    const tagged = lastError as TranscriptionError | undefined;
    const err = new Error(
      `Failed to transcribe chunk ${chunkNum}/${totalChunks} after ${MAX_CHUNK_ATTEMPTS} attempts: ${tagged?.message ?? 'unknown error'}`,
    ) as TranscriptionError;
    err.errorClass = tagged?.errorClass ?? 'unknown';
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
 * Computes the wait before retry attempt `attempt + 1`.
 *
 * Exponential (base doubles per attempt, capped at RETRY_MAX_DELAY_MS) with
 * full-range jitter so parallel workers that failed together don't retry in
 * lockstep and re-trigger the same rate limit. When the server sent a
 * Retry-After, that takes precedence (plus a little jitter) — the server
 * knows its own capacity better than our schedule does.
 */
function computeBackoffMs(
  attempt: number,
  errorClass: TranscriptionErrorClass,
  retryAfterSeconds?: number,
): number {
  if (errorClass === 'rate_limit' && retryAfterSeconds) {
    // Honor the server's wait, with up to +25% jitter to spread workers out.
    return Math.round(retryAfterSeconds * 1000 * (1 + Math.random() * 0.25));
  }

  const weight = errorClass === 'rate_limit' ? 2 : 1;
  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * weight * 2 ** (attempt - 1),
    RETRY_MAX_DELAY_MS,
  );
  // Jitter across [50%, 100%] of the computed delay.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
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
