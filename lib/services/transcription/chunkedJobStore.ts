/**
 * Blob-backed job state storage for chunked transcription.
 *
 * Records live at `{userId}/transcription-jobs/{jobId}.json` in the user-data
 * container (same convention as translationJobStore's
 * `{userId}/translations/jobs/`), so any replica can serve a status poll and
 * job state survives restarts — the previous /tmp JSON store lost both.
 *
 * Every function takes the caller's session-scoped {@link BlobStorage}
 * (createBlobStorageClient resolves the user's REGIONAL storage account, so
 * there is no process-global client to reach for) — which also makes the
 * store fully fakeable in tests.
 *
 * Concurrency: mutations are compare-and-swap (ETag `ifMatch` on update,
 * `ifNoneMatch: '*'` on create) with bounded re-read-and-reapply on 412.
 * This replaces the old fs advisory lock and preserves the same invariant:
 * terminal states (succeeded/failed/cancelled) can never be overwritten by a
 * late progress write, even across replicas.
 *
 * NOTE: the ffmpeg chunk files themselves are still local disk — the
 * processing loop must complete on the replica that started it. Only the job
 * STATE is multi-replica-safe.
 */
import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

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
  /** Paths to chunk files (for cleanup; local to the starting replica) */
  chunkPaths: string[];
  /** Original filename for display */
  filename: string;
  /** Job creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/** UUID format for transcription job IDs. Shared across every route. */
export const JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** User-visible error text recorded on a cancelled chunked job. */
export const JOB_CANCELLED_MESSAGE = 'Cancelled by user';

/** Error text recorded when a stale in-flight job is lazily failed. */
export const JOB_INTERRUPTED_MESSAGE = 'Job interrupted by server restart';

/**
 * An active (pending/processing) job whose updatedAt is older than this is
 * treated as dead at poll time: the processing loop bumps updatedAt on every
 * chunk completion, and the client's per-chunk polling budget is 2 minutes
 * (PER_CHUNK_TIMEOUT_MS in client/hooks/transcription/useTranscriptionPolling.ts)
 * — 5 minutes of silence means the loop's process is gone (restart/crash),
 * because no single chunk legitimately takes that long without a progress
 * write. This lazy check replaces the old startup-time
 * markInterruptedJobsFailed sweep, which needed a session-less global listing
 * and was wrong under multiple replicas (one replica's restart must not fail
 * jobs still running on another).
 */
export const STALE_JOB_MS = 5 * 60 * 1000;

/**
 * How long to keep job records before lazy deletion on read.
 *
 * Must exceed the client's maximum polling window
 * (MAX_TRANSCRIPTION_TIMEOUT_MS in useTranscriptionPolling.ts, currently 2h),
 * otherwise a client that reconnects late polls a 404 and a completed
 * transcript is silently lost. 24h gives ample slack.
 *
 * Deletion is lazy (on read) rather than delegated to a container lifecycle
 * policy so the behavior doesn't depend on infra configuration being present
 * in every environment; records are tiny JSON, so anything never re-read and
 * therefore never deleted costs effectively nothing.
 */
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Bounded CAS retries: re-read and re-apply on 412, then give up. */
const CAS_MAX_ATTEMPTS = 4;

/**
 * Builds the blob path for a job record. jobId is regex-enforced on every
 * path build — a non-UUID id can never reach the blob name.
 */
function jobBlobPath(userId: string, jobId: string): string {
  if (!JOB_ID_REGEX.test(jobId)) {
    throw new Error('Invalid job ID format');
  }
  return `${userId}/transcription-jobs/${jobId}.json`;
}

/** Azure SDK errors carry the HTTP status as `statusCode` or `status`. */
function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

function streamToBuffer(
  readableStream: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => resolve(Buffer.concat(chunks)));
    readableStream.on('error', reject);
  });
}

/** Downloads a job record with its ETag. Returns null (not throws) on 404. */
async function readJobBlob(
  storage: BlobStorage,
  blobPath: string,
): Promise<{ job: ChunkedJob; etag: string } | null> {
  const client = storage.getBlockBlobClient(blobPath);
  try {
    return await withAzureRetry(
      async () => {
        const response = await client.download();
        if (!response.readableStreamBody) {
          throw new Error(`No readable stream for blob ${blobPath}`);
        }
        const buffer = await streamToBuffer(response.readableStreamBody);
        return {
          job: JSON.parse(buffer.toString('utf8')) as ChunkedJob,
          etag: response.etag ?? '',
        };
      },
      { label: 'chunkedJobStore.read' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

/**
 * Conditional JSON write. `ifMatchEtag` null → creation only
 * (`If-None-Match: *`). A 412 propagates to the caller — `withAzureRetry`
 * only retries 5xx/network, so precondition failures surface immediately.
 *
 * Deliberately bypasses `AzureBlobStorage.upload()`: its same-byte-length
 * dedupe silently drops writes whose new content matches the stored length —
 * fatal for progress JSON where `"completedChunks":1` → `"completedChunks":2`
 * is exactly that case — and it carries no ETag conditions.
 */
async function writeJobBlob(
  storage: BlobStorage,
  blobPath: string,
  job: ChunkedJob,
  ifMatchEtag: string | null,
): Promise<void> {
  const client = storage.getBlockBlobClient(blobPath);
  const content = Buffer.from(JSON.stringify(job), 'utf8');
  await withAzureRetry(
    () =>
      client.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: ifMatchEtag
          ? { ifMatch: ifMatchEtag }
          : { ifNoneMatch: '*' },
      }),
    { label: 'chunkedJobStore.write' },
  );
}

/**
 * Reads the job, applies `apply` only while the job is still active
 * (pending/processing), and persists the result with an ETag-conditional
 * write. On 412 (another writer — possibly on another replica — won the
 * race) the whole read-check-apply-write cycle reruns against the fresh
 * state, bounded by CAS_MAX_ATTEMPTS.
 *
 * This is the single write path for status transitions: terminal states
 * (succeeded/failed/cancelled) can never be overwritten by a late progress
 * update or a racing completion — the post-412 re-read re-checks the status
 * before reapplying.
 *
 * @returns true if the mutation was applied; false if the job was already
 *   terminal and the call was a no-op.
 * @throws Error when no job record exists for `jobId`.
 */
async function mutateActiveJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
  apply: (job: ChunkedJob) => void,
): Promise<boolean> {
  const blobPath = jobBlobPath(userId, jobId);
  let lastError: unknown;
  for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt++) {
    const record = await readJobBlob(storage, blobPath);
    if (!record) {
      throw new Error(`Job ${jobId} not found`);
    }
    const job = record.job;
    if (job.status !== 'pending' && job.status !== 'processing') {
      return false;
    }
    apply(job);
    job.updatedAt = Date.now();
    try {
      await writeJobBlob(storage, blobPath, job, record.etag);
      return true;
    } catch (error) {
      lastError = error;
      if (statusCodeOf(error) !== 412) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Job ${jobId} mutation lost ${CAS_MAX_ATTEMPTS} CAS races`);
}

/**
 * Creates a new chunked transcription job. `If-None-Match: *` — jobIds are
 * fresh UUIDs, so an existing blob at this path means a caller bug, not a
 * race to resolve.
 */
export async function createJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
  totalChunks: number,
  chunkPaths: string[],
  filename: string,
): Promise<void> {
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

  await writeJobBlob(storage, jobBlobPath(userId, jobId), job, null);

  console.log(
    `[ChunkedJobStore] Created job ${jobId}: ${totalChunks} chunks for "${filename}"`,
  );
}

/**
 * Updates job progress. Also bumps updatedAt (via mutateActiveJob), which is
 * what keeps an in-flight job from tripping the STALE_JOB_MS check at poll
 * time — the processing loop calls this after every chunk completion.
 *
 * @param completedChunks - Number of chunks completed so far
 * @param currentChunk - 0-based index of the chunk currently being processed
 *   (i.e., the chunk that has just been started, not yet completed)
 * @throws Error when no job record exists for `jobId`.
 */
export async function updateProgress(
  storage: BlobStorage,
  jobId: string,
  userId: string,
  completedChunks: number,
  currentChunk?: number,
): Promise<void> {
  // mutateActiveJob bails if the job is already terminal — a background
  // chunk that finishes after the user cancelled (or after a failure was
  // recorded) must not clobber the terminal status back to 'processing'.
  const applied = await mutateActiveJob(storage, jobId, userId, (job) => {
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
 * @throws Error when no job record exists for `jobId`.
 */
export async function completeJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
  transcript: string,
): Promise<void> {
  // Preserve terminal status. If the user cancelled while the final chunks
  // were in flight, the combined-transcript write must not flip the job
  // back to 'succeeded'. The transcript is discarded by design — cancelled
  // means the user doesn't want it.
  const applied = await mutateActiveJob(storage, jobId, userId, (job) => {
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
 * @param error - Human-readable error message
 * @param errorClass - Optional classification so clients can branch on
 *   recovery UX (e.g. auto-retry vs re-auth vs permanent).
 * @throws Error when no job record exists for `jobId`.
 */
export async function failJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
  error: string,
  errorClass?: TranscriptionErrorClass,
): Promise<void> {
  // Preserve terminal status. A background chunk that errors after the user
  // cancelled (or after a different branch already recorded success/failure)
  // must not flip the stored outcome — cancelled must stay cancelled, a
  // succeeded job must not revert to failed.
  const applied = await mutateActiveJob(storage, jobId, userId, (job) => {
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
 * Marks a job as cancelled by the user. Cooperative — the background chunk
 * processor re-reads job status between chunks and aborts when it sees this.
 *
 * @throws Error when no job record exists for `jobId`.
 */
export async function cancelJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
): Promise<void> {
  // mutateActiveJob no-ops (returns false) when the job is already terminal.
  const applied = await mutateActiveJob(storage, jobId, userId, (job) => {
    job.status = 'cancelled';
    job.error = JOB_CANCELLED_MESSAGE;
  });

  if (applied) {
    console.log(`[ChunkedJobStore] Job ${jobId} cancelled by user`);
  }
}

/**
 * Shared read path: regex guard, 404 → undefined, and lazy retention.
 * Records past JOB_RETENTION_MS are treated as gone and deleted best-effort
 * (lazy retention — there is no active sweep).
 */
async function loadJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
): Promise<{ job: ChunkedJob; etag: string; blobPath: string } | undefined> {
  // Malformed ids read as "not found" rather than throwing, matching how
  // routes treat unknown jobs.
  if (!JOB_ID_REGEX.test(jobId)) {
    return undefined;
  }
  const blobPath = jobBlobPath(userId, jobId);

  let record: { job: ChunkedJob; etag: string } | null;
  try {
    record = await readJobBlob(storage, blobPath);
  } catch (error) {
    console.warn('[ChunkedJobStore] Error reading job %s:', jobId, error);
    return undefined;
  }
  if (!record) {
    return undefined;
  }

  if (Date.now() - record.job.createdAt > JOB_RETENTION_MS) {
    // Best-effort: a failed delete just means the next read retries it.
    try {
      await storage.deleteIfExists(blobPath);
    } catch (error) {
      console.warn(
        `[ChunkedJobStore] Could not delete expired job ${jobId}:`,
        error,
      );
    }
    return undefined;
  }

  return { ...record, blobPath };
}

/**
 * Gets a job by ID as stored — no staleness transform (the processing loop
 * uses this between chunks and must not see its own slow-but-alive job
 * spuriously flipped to failed; only the poll path applies STALE_JOB_MS).
 *
 * @returns The job, or undefined if not found / malformed id / expired.
 */
export async function getJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
): Promise<ChunkedJob | undefined> {
  return (await loadJob(storage, jobId, userId))?.job;
}

/**
 * Gets a job by ID, but only if it belongs to the given user. Returns
 * undefined on mismatch so callers can't distinguish "not yours" from "not
 * found" (prevents enumeration). The blob path is already user-scoped; the
 * userId field check is defense in depth.
 *
 * This is the status-poll read path, so the STALE_JOB_MS check lives here:
 * an active job whose loop has stopped writing progress is returned as
 * failed (transient, "interrupted by server restart"), and that
 * transformation is persisted best-effort with a SINGLE conditional write
 * pinned to the ETag just read — no CAS retry loop, deliberately: a 412 here
 * means someone else wrote the job after our read (most likely the loop is
 * alive after all and just recorded progress), so re-applying the failure
 * against fresh state would kill a healthy job. The next poll re-evaluates.
 */
export async function getJobForUser(
  storage: BlobStorage,
  jobId: string,
  userId: string,
): Promise<ChunkedJob | undefined> {
  const loaded = await loadJob(storage, jobId, userId);
  if (!loaded || loaded.job.userId !== userId) {
    return undefined;
  }
  const { job, etag, blobPath } = loaded;

  const isActive = job.status === 'pending' || job.status === 'processing';
  if (isActive && Date.now() - job.updatedAt > STALE_JOB_MS) {
    const failed: ChunkedJob = {
      ...job,
      status: 'failed',
      error: JOB_INTERRUPTED_MESSAGE,
      // Transient so clients render "please try again" instead of treating
      // a restart as a permanent failure.
      errorClass: 'transient',
      updatedAt: Date.now(),
    };
    try {
      await writeJobBlob(storage, blobPath, failed, etag);
      console.log(
        `[ChunkedJobStore] Job ${sanitizeForLog(jobId)} marked failed after ` +
          `${STALE_JOB_MS}ms without progress (interrupted loop)`,
      );
    } catch (error) {
      if (statusCodeOf(error) !== 412) {
        // The message is a CONSTANT: interpolating jobId here would put
        // caller data in console's format-string position, where a `%s`
        // would consume the `error` argument (sanitizeForLog strips control
        // characters but deliberately leaves `%` alone).
        console.warn(
          '[ChunkedJobStore] Could not persist stale-job failure for job:',
          sanitizeForLog(jobId),
          error,
        );
      }
    }
    // The caller sees the transformed job either way — persistence is
    // best-effort, the poll response is not.
    return failed;
  }

  return job;
}

/**
 * Deletes a job record. Best-effort — idempotent via deleteIfExists.
 */
export async function deleteJob(
  storage: BlobStorage,
  jobId: string,
  userId: string,
): Promise<void> {
  const blobPath = jobBlobPath(userId, jobId);
  try {
    if (await storage.deleteIfExists(blobPath)) {
      console.log(`[ChunkedJobStore] Deleted job ${jobId}`);
    }
  } catch (error) {
    console.warn(`[ChunkedJobStore] Error deleting job ${jobId}:`, error);
  }
}

/** Root directory holding per-job chunk subdirectories (local disk). */
const CHUNK_DIR_ROOT = path.join(os.tmpdir(), 'chunked-transcription');

/**
 * Removes all per-job chunk directories on THIS replica's local disk.
 * Intended for server startup only: chunk files are produced and consumed by
 * an in-process pipeline, so after a restart every dir under the root is by
 * definition orphaned — the loop that would have consumed it died with the
 * previous process. (Job records live in blob storage and are reconciled
 * lazily at poll time via STALE_JOB_MS, not here.)
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

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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
