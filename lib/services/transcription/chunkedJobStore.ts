/**
 * File-based job state storage for chunked transcription.
 *
 * Stores the state of async chunked transcription jobs as JSON files
 * in /tmp/chunked-transcription-jobs/. This ensures persistence across
 * Next.js API route invocations (unlike in-memory storage which can be
 * lost due to hot reloading or serverless function restarts).
 *
 * Jobs are tracked from submission through completion.
 */
import { TranscriptionErrorClass } from '@/types/transcription';

import * as fs from 'fs';
import * as path from 'path';

export type ChunkedJobStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ChunkedJob {
  /** Unique job identifier */
  jobId: string;
  /** ID of the user who owns this job */
  userId: string;
  /** Current job status */
  status: ChunkedJobStatus;
  /** Total number of chunks to process */
  totalChunks: number;
  /** Number of chunks completed */
  completedChunks: number;
  /** Index of the chunk currently being processed */
  currentChunk: number;
  /** Combined transcript (only set when succeeded) */
  transcript?: string;
  /** Error message (only set when failed) */
  error?: string;
  /**
   * Classification of the failure cause — clients use this to pick recovery
   * UX (retry vs re-auth vs format error). Absent for unknown errors or
   * non-failure states.
   */
  errorClass?: TranscriptionErrorClass;
  /** Paths to chunk files (for cleanup) */
  chunkPaths: string[];
  /** Path to original audio file (for cleanup) */
  originalAudioPath?: string;
  /** Original filename for display */
  filename: string;
  /** Job creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/** Directory for storing job JSON files */
const JOB_STORE_DIR = '/tmp/chunked-transcription-jobs';

/** How long to keep completed/failed jobs before cleanup (1 hour) */
const JOB_RETENTION_MS = 60 * 60 * 1000;

/**
 * Validates that a job ID contains only safe characters.
 * Prevents path traversal attacks.
 *
 * @param jobId - The job ID to validate
 * @throws Error if the job ID format is invalid
 */
/** UUID format for transcription job IDs. Shared across every route. */
export const JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** User-visible error text recorded on a cancelled chunked job. */
export const JOB_CANCELLED_MESSAGE = 'Cancelled by user';

function validateJobId(jobId: string): void {
  // Job IDs must be UUIDs. Strict format blocks path traversal and
  // any accidental filesystem-unsafe characters.
  if (!JOB_ID_REGEX.test(jobId)) {
    throw new Error('Invalid job ID format');
  }
}

/**
 * Ensures the job store directory exists with secure permissions.
 * Directory is created with mode 0o700 (owner read/write/execute only).
 */
function ensureStoreDir(): void {
  if (!fs.existsSync(JOB_STORE_DIR)) {
    fs.mkdirSync(JOB_STORE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Gets the file path for a job's JSON file.
 * Validates jobId to prevent path traversal attacks.
 *
 * @param jobId - The job ID
 * @returns The full path to the job's JSON file
 * @throws Error if jobId format is invalid
 */
function getJobFilePath(jobId: string): string {
  validateJobId(jobId);
  return path.join(JOB_STORE_DIR, `${jobId}.json`);
}

/**
 * Saves a job to the file system with secure permissions.
 * Files are created with mode 0o600 (owner read/write only).
 *
 * Uses a tmp-then-rename pattern so concurrent readers never observe
 * a partially written file. `rename` is atomic on the same filesystem.
 */
function saveJob(job: ChunkedJob): void {
  ensureStoreDir();
  const filePath = getJobFilePath(job.jobId);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Creates a new chunked transcription job.
 *
 * @param jobId - Unique job identifier
 * @param userId - ID of the user who owns this job
 * @param totalChunks - Total number of chunks to process
 * @param chunkPaths - Paths to the chunk files
 * @param filename - Original filename for display
 * @param originalAudioPath - Path to original extracted audio (for cleanup)
 */
export function createJob(
  jobId: string,
  userId: string,
  totalChunks: number,
  chunkPaths: string[],
  filename: string,
  originalAudioPath?: string,
): void {
  const now = Date.now();

  const job: ChunkedJob = {
    jobId,
    userId,
    status: 'pending',
    totalChunks,
    completedChunks: 0,
    currentChunk: 0,
    chunkPaths,
    originalAudioPath,
    filename,
    createdAt: now,
    updatedAt: now,
  };

  saveJob(job);

  console.log(
    `[ChunkedJobStore] Created job ${jobId}: ${totalChunks} chunks for "${filename}"`,
  );

  // Schedule cleanup of stale jobs
  scheduleCleanup();
}

/**
 * Updates job progress.
 *
 * @param jobId - Job identifier
 * @param completedChunks - Number of chunks completed so far
 * @param currentChunk - 0-based index of the chunk currently being processed
 *   (i.e., the chunk that has just been started, not yet completed)
 * @throws Error when no job record exists for `jobId`.
 */
export function updateProgress(
  jobId: string,
  completedChunks: number,
  currentChunk?: number,
): void {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Bail if the job is already terminal — a background chunk that finishes
  // after the user cancelled (or after a failure was recorded) must not
  // clobber the terminal status back to 'processing'. Racing writes are
  // otherwise resolved last-writer-wins by the tmp+rename save path.
  if (job.status !== 'pending' && job.status !== 'processing') {
    return;
  }

  job.status = 'processing';
  job.completedChunks = completedChunks;
  if (currentChunk !== undefined) {
    job.currentChunk = currentChunk;
  }
  job.updatedAt = Date.now();

  saveJob(job);

  console.log(
    `[ChunkedJobStore] Job ${jobId} progress: ${completedChunks}/${job.totalChunks} chunks`,
  );
}

/**
 * Marks a job as successfully completed.
 *
 * @param jobId - Job identifier
 * @param transcript - Combined transcript text
 * @throws Error when no job record exists for `jobId`.
 */
export function completeJob(jobId: string, transcript: string): void {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Preserve terminal status. If the user cancelled while the final batch
  // was in flight, the combined-transcript write must not flip the job
  // back to 'succeeded'. The transcript is discarded by design — cancelled
  // means the user doesn't want it.
  if (job.status !== 'pending' && job.status !== 'processing') {
    return;
  }

  job.status = 'succeeded';
  job.completedChunks = job.totalChunks;
  job.transcript = transcript;
  job.updatedAt = Date.now();

  saveJob(job);

  console.log(
    `[ChunkedJobStore] Job ${jobId} completed successfully with ${transcript.length} chars`,
  );
}

/**
 * Marks a job as failed.
 *
 * @param jobId - Job identifier
 * @param error - Human-readable error message
 * @param errorClass - Optional classification so clients can branch on
 *   recovery UX (e.g. auto-retry vs re-auth vs permanent).
 * @throws Error when no job record exists for `jobId`.
 */
export function failJob(
  jobId: string,
  error: string,
  errorClass?: TranscriptionErrorClass,
): void {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  job.status = 'failed';
  job.error = error;
  job.errorClass = errorClass;
  job.updatedAt = Date.now();

  saveJob(job);

  console.error(
    `[ChunkedJobStore] Job ${jobId} failed (${errorClass ?? 'unclassified'}): ${error}`,
  );
}

/**
 * Gets a job by ID.
 *
 * @param jobId - Job identifier
 * @returns The job, or undefined if not found
 */
export function getJob(jobId: string): ChunkedJob | undefined {
  const filePath = getJobFilePath(jobId);

  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as ChunkedJob;
  } catch (error) {
    console.warn(`[ChunkedJobStore] Error reading job ${jobId}:`, error);
    return undefined;
  }
}

/**
 * Gets a job by ID, but only if it belongs to the given user.
 * Returns undefined on mismatch so callers can't distinguish
 * "not yours" from "not found" (prevents enumeration).
 */
export function getJobForUser(
  jobId: string,
  userId: string,
): ChunkedJob | undefined {
  const job = getJob(jobId);
  if (!job || job.userId !== userId) {
    return undefined;
  }
  return job;
}

/**
 * Deletes a job from the store.
 *
 * @param jobId - Job identifier
 */
export function deleteJob(jobId: string): void {
  const filePath = getJobFilePath(jobId);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[ChunkedJobStore] Deleted job ${jobId}`);
    }
  } catch (error) {
    console.warn(`[ChunkedJobStore] Error deleting job ${jobId}:`, error);
  }
}

/**
 * Lists all jobs (for debugging/monitoring).
 */
export function listJobs(): ChunkedJob[] {
  ensureStoreDir();

  const jobs: ChunkedJob[] = [];

  try {
    const files = fs.readdirSync(JOB_STORE_DIR);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(JOB_STORE_DIR, file);
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const job = JSON.parse(data) as ChunkedJob;
        jobs.push(job);
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory might not exist yet
  }

  return jobs;
}

/**
 * Gets the number of active (non-completed) jobs.
 */
export function getActiveJobCount(): number {
  const jobs = listJobs();
  return jobs.filter(
    (job) => job.status === 'pending' || job.status === 'processing',
  ).length;
}

/**
 * Marks any job that was mid-flight (pending or processing) when the server
 * was last stopped as failed with a recognizable reason. Intended to be
 * called once at server startup so clients polling such jobs see a clean
 * failure rather than a permanent 404.
 *
 * @returns The job IDs that were marked failed.
 */
export function markInterruptedJobsFailed(): string[] {
  const marked: string[] = [];
  const jobs = listJobs();
  for (const job of jobs) {
    if (job.status !== 'pending' && job.status !== 'processing') continue;
    try {
      // Classify as transient so clients render a "please try again" message
      // instead of treating a restart as a permanent failure.
      failJob(job.jobId, 'Job interrupted by server restart', 'transient');
      marked.push(job.jobId);
    } catch (err) {
      console.warn(
        `[ChunkedJobStore] Could not mark interrupted job ${job.jobId}:`,
        err,
      );
    }
  }
  if (marked.length > 0) {
    console.log(
      `[ChunkedJobStore] Marked ${marked.length} interrupted job(s) as failed on startup`,
    );
  }
  return marked;
}

/**
 * Marks a job as cancelled by the user. Cooperative — the background chunk
 * processor polls job status between batches and aborts when it sees this.
 *
 * @throws Error when no job record exists for `jobId`.
 */
export function cancelJob(jobId: string): void {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  // Already terminal — no-op.
  if (
    job.status === 'succeeded' ||
    job.status === 'failed' ||
    job.status === 'cancelled'
  ) {
    return;
  }
  job.status = 'cancelled';
  job.error = JOB_CANCELLED_MESSAGE;
  job.updatedAt = Date.now();
  saveJob(job);
  console.log(`[ChunkedJobStore] Job ${jobId} cancelled by user`);
}

// Cleanup timer reference
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Schedules cleanup of stale completed/failed jobs.
 * Runs every 10 minutes if there are jobs in the store.
 */
function scheduleCleanup(): void {
  if (cleanupTimer) {
    return; // Already scheduled
  }

  cleanupTimer = setTimeout(
    () => {
      cleanupTimer = null;
      runCleanup();

      // Reschedule if there are still jobs
      const jobs = listJobs();
      if (jobs.length > 0) {
        scheduleCleanup();
      }
    },
    10 * 60 * 1000,
  ); // 10 minutes
  // Don't block Node from exiting just because the cleanup timer is pending.
  cleanupTimer.unref?.();
}

/**
 * Removes stale completed/failed jobs from the store.
 */
function runCleanup(): void {
  const now = Date.now();
  let cleaned = 0;

  const jobs = listJobs();

  for (const job of jobs) {
    // Only clean up jobs in a terminal state.
    if (
      job.status !== 'succeeded' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    ) {
      continue;
    }

    // Check if job is old enough to clean up
    const age = now - job.updatedAt;
    if (age > JOB_RETENTION_MS) {
      deleteJob(job.jobId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    const remaining = listJobs().length;
    console.log(
      `[ChunkedJobStore] Cleanup: removed ${cleaned} stale jobs, ${remaining} remaining`,
    );
  }
}
