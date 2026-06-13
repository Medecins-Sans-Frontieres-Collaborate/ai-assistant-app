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
import * as os from 'os';
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
  /** Original filename for display */
  filename: string;
  /** Job creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/** Directory for storing job JSON files */
const JOB_STORE_DIR = '/tmp/chunked-transcription-jobs';

/**
 * How long to keep completed/failed jobs before cleanup.
 *
 * Must exceed the client's maximum polling window
 * (MAX_TRANSCRIPTION_TIMEOUT_MS in useTranscriptionPolling.ts, currently 2h),
 * otherwise a client that reconnects late polls a 404 and a completed
 * transcript is silently lost. 3h = client ceiling + 1h slack.
 */
const JOB_RETENTION_MS = 3 * 60 * 60 * 1000;

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
  // PID + timestamp + small random suffix — the random chunk covers the
  // otherwise-possible collision of two writes for the same job in the same
  // millisecond inside the same process.
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomSuffix}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

/** How long a held lock may live before another writer treats it as stale. */
const LOCK_STALE_MS = 2_000;
/** Sleep between lock-acquisition attempts. */
const LOCK_RETRY_DELAY_MS = 5;
/** Give up acquiring the lock after this long and fall back to lock-free. */
const LOCK_MAX_WAIT_MS = 250;

// Atomics.wait needs a SharedArrayBuffer-backed view; this one exists solely
// to implement a synchronous sleep without spinning the CPU.
const lockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(lockSleepBuffer, 0, 0, ms);
}

/**
 * Acquires a per-job advisory lock (a lock directory next to the job file).
 *
 * Within one Node process the store's synchronous read-modify-write calls
 * already can't interleave; this lock guards the cross-process case (e.g.
 * a cluster-mode deployment that violates the documented single-replica
 * assumption) so a cancel can't be silently clobbered by a concurrent
 * progress write. Locks held longer than LOCK_STALE_MS are assumed to come
 * from a crashed process and are broken.
 *
 * @returns A release function, or null if the lock could not be acquired
 *   within LOCK_MAX_WAIT_MS (callers proceed lock-free rather than failing).
 */
function acquireJobLock(jobId: string): (() => void) | null {
  validateJobId(jobId);
  ensureStoreDir();
  const lockDir = path.join(JOB_STORE_DIR, `${jobId}.lock`);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch {
          // Already removed (e.g. broken as stale by another writer).
        }
      };
    } catch {
      // Lock exists — break it if stale, otherwise wait and retry.
      try {
        const lockAge = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (lockAge > LOCK_STALE_MS) {
          try {
            fs.rmdirSync(lockDir);
          } catch {
            // Another writer broke it first.
          }
          continue;
        }
      } catch {
        // Lock vanished between mkdir and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        console.warn(
          `[ChunkedJobStore] Could not acquire lock for job ${jobId} within ${LOCK_MAX_WAIT_MS}ms; proceeding without it`,
        );
        return null;
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
}

/**
 * Reads the job, applies `apply` only while the job is still active
 * (pending/processing), and persists the result — all under the per-job
 * advisory lock so the freshest state is what gets checked and written.
 *
 * This is the single write path for status transitions: terminal states
 * (succeeded/failed/cancelled) can never be overwritten by a late progress
 * update or a racing completion.
 *
 * @returns true if the mutation was applied; false if the job was already
 *   terminal and the call was a no-op.
 * @throws Error when no job record exists for `jobId`.
 */
function mutateActiveJob(
  jobId: string,
  apply: (job: ChunkedJob) => void,
): boolean {
  const release = acquireJobLock(jobId);
  try {
    const job = getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.status !== 'pending' && job.status !== 'processing') {
      return false;
    }
    apply(job);
    job.updatedAt = Date.now();
    saveJob(job);
    return true;
  } finally {
    release?.();
  }
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
  // mutateActiveJob bails if the job is already terminal — a background
  // chunk that finishes after the user cancelled (or after a failure was
  // recorded) must not clobber the terminal status back to 'processing'.
  const applied = mutateActiveJob(jobId, (job) => {
    job.status = 'processing';
    job.completedChunks = completedChunks;
    if (currentChunk !== undefined) {
      job.currentChunk = currentChunk;
    }
  });

  if (applied) {
    console.log(
      `[ChunkedJobStore] Job ${jobId} progress: ${completedChunks} chunks completed`,
    );
  }
}

/**
 * Marks a job as successfully completed.
 *
 * @param jobId - Job identifier
 * @param transcript - Combined transcript text
 * @throws Error when no job record exists for `jobId`.
 */
export function completeJob(jobId: string, transcript: string): void {
  // Preserve terminal status. If the user cancelled while the final chunks
  // were in flight, the combined-transcript write must not flip the job
  // back to 'succeeded'. The transcript is discarded by design — cancelled
  // means the user doesn't want it.
  const applied = mutateActiveJob(jobId, (job) => {
    job.status = 'succeeded';
    job.completedChunks = job.totalChunks;
    job.transcript = transcript;
  });

  if (applied) {
    console.log(
      `[ChunkedJobStore] Job ${jobId} completed successfully with ${transcript.length} chars`,
    );
  }
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
  // Preserve terminal status. A background chunk that errors after the user
  // cancelled (or after a different branch already recorded success/failure)
  // must not flip the stored outcome — cancelled must stay cancelled, a
  // succeeded job must not revert to failed.
  const applied = mutateActiveJob(jobId, (job) => {
    job.status = 'failed';
    job.error = error;
    job.errorClass = errorClass;
  });

  if (applied) {
    console.error(
      `[ChunkedJobStore] Job ${jobId} failed (${errorClass ?? 'unclassified'}): ${error}`,
    );
  }
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

/** Root directory holding per-job chunk subdirectories. */
const CHUNK_DIR_ROOT = path.join(os.tmpdir(), 'chunked-transcription');

/**
 * Best-effort removal of a job's on-disk chunk artifacts: the chunk files
 * themselves plus any per-job directory under the chunked-transcription
 * tmpdir root. Never throws — artifact cleanup must not block status
 * reconciliation.
 */
function cleanupJobArtifacts(job: ChunkedJob): void {
  for (const chunkPath of job.chunkPaths) {
    try {
      fs.unlinkSync(chunkPath);
    } catch {
      // Already gone or unreadable — nothing useful to do.
    }
  }
  const parents = new Set(job.chunkPaths.map((p) => path.dirname(p)));
  for (const parent of parents) {
    if (parent.startsWith(CHUNK_DIR_ROOT + path.sep)) {
      try {
        fs.rmSync(parent, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * Marks any job that was mid-flight (pending or processing) when the server
 * was last stopped as failed with a recognizable reason, and removes the
 * job's chunk files — they can never be consumed once the in-process
 * pipeline that produced them is gone. Intended to be called once at server
 * startup so clients polling such jobs see a clean failure rather than a
 * permanent 404.
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
    // Even if the status write failed, the chunks are unusable — reclaim
    // the disk either way.
    cleanupJobArtifacts(job);
  }
  if (marked.length > 0) {
    console.log(
      `[ChunkedJobStore] Marked ${marked.length} interrupted job(s) as failed on startup`,
    );
  }
  return marked;
}

/**
 * Removes per-job chunk directories whose job record no longer exists or is
 * already terminal. Safe to run at startup (no job can be actively writing
 * chunks yet) — covers dirs orphaned by crashes that predate their job
 * record, and dirs whose record was already removed by retention cleanup.
 *
 * @returns The directory names that were removed.
 */
export function sweepOrphanedChunkDirs(): string[] {
  const removed: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CHUNK_DIR_ROOT, { withFileTypes: true });
  } catch {
    // Root doesn't exist yet — nothing to sweep.
    return removed;
  }

  const liveJobIds = new Set(
    listJobs()
      .filter((job) => job.status === 'pending' || job.status === 'processing')
      .map((job) => job.jobId),
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (liveJobIds.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(CHUNK_DIR_ROOT, entry.name), {
        recursive: true,
        force: true,
      });
      removed.push(entry.name);
    } catch (err) {
      console.warn(
        `[ChunkedJobStore] Could not remove orphaned chunk dir ${entry.name}:`,
        err,
      );
    }
  }

  if (removed.length > 0) {
    console.log(
      `[ChunkedJobStore] Swept ${removed.length} orphaned chunk dir(s)`,
    );
  }
  return removed;
}

/**
 * Marks a job as cancelled by the user. Cooperative — the background chunk
 * processor polls job status between batches and aborts when it sees this.
 *
 * @throws Error when no job record exists for `jobId`.
 */
export function cancelJob(jobId: string): void {
  // mutateActiveJob no-ops (returns false) when the job is already terminal.
  const applied = mutateActiveJob(jobId, (job) => {
    job.status = 'cancelled';
    job.error = JOB_CANCELLED_MESSAGE;
  });

  if (applied) {
    console.log(`[ChunkedJobStore] Job ${jobId} cancelled by user`);
  }
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
