/**
 * File-based ownership registry for legacy Azure Batch transcription jobs.
 *
 * Batch jobs live in Azure and have no local job record, which historically
 * meant any authenticated user who learned a job GUID could poll its status,
 * read its transcript, or delete it. This registry records jobId → userId at
 * submission time so the status and cleanup routes can enforce ownership.
 *
 * Same persistence model and constraints as chunkedJobStore: JSON files
 * under /tmp, single-replica only.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Directory for storing ownership records. */
const REGISTRY_DIR = '/tmp/batch-transcription-jobs';

/**
 * How long to keep ownership records. Generous: Azure batch jobs can take
 * hours, and a record outliving its job is harmless (lookups just 404 on the
 * Azure side), while a record expiring early would lock the owner out.
 */
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Azure batch job IDs are GUIDs — same shape as chunked job IDs. */
const BATCH_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BatchJobRecord {
  jobId: string;
  userId: string;
  createdAt: number;
}

function recordPath(jobId: string): string {
  if (!BATCH_JOB_ID_REGEX.test(jobId)) {
    throw new Error('Invalid batch job ID format');
  }
  return path.join(REGISTRY_DIR, `${jobId}.json`);
}

/**
 * Records the owner of a freshly submitted batch transcription job.
 * Never throws — a registry write failure must not fail the submission;
 * the job just behaves like a pre-registry legacy job.
 */
export function recordBatchJobOwner(jobId: string, userId: string): void {
  try {
    const filePath = recordPath(jobId);
    if (!fs.existsSync(REGISTRY_DIR)) {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    }
    const record: BatchJobRecord = { jobId, userId, createdAt: Date.now() };
    // tmp-then-rename so concurrent readers never see a partial file.
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(record), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
    pruneStaleRecords();
  } catch (err) {
    console.warn(
      `[BatchJobRegistry] Could not record owner for job ${jobId}:`,
      err,
    );
  }
}

/**
 * Looks up the recorded owner of a batch job.
 *
 * @returns The owning userId, or undefined when no record exists (job
 *   submitted before this registry was deployed, or record expired).
 */
export function getBatchJobOwner(jobId: string): string | undefined {
  try {
    const filePath = recordPath(jobId);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const record = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as BatchJobRecord;
    return typeof record.userId === 'string' ? record.userId : undefined;
  } catch (err) {
    console.warn(
      `[BatchJobRegistry] Could not read owner for job ${jobId}:`,
      err,
    );
    return undefined;
  }
}

/**
 * Checks whether the given user may access the given batch job.
 *
 * Policy: with a record, only the recorded owner may access. Without a
 * record we DENY — an unknown GUID is more likely a probe than a legitimate
 * pre-registry job, and the batch path is deprecated. Callers should return
 * an indistinguishable 404 on denial to prevent jobId enumeration.
 */
export function userOwnsBatchJob(jobId: string, userId: string): boolean {
  const owner = getBatchJobOwner(jobId);
  if (owner === undefined) {
    console.warn(
      `[BatchJobRegistry] Denying access to unregistered batch job ${jobId}`,
    );
    return false;
  }
  return owner === userId;
}

/** Removes the ownership record (after the Azure-side job is deleted). */
export function deleteBatchJobRecord(jobId: string): void {
  try {
    const filePath = recordPath(jobId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(
      `[BatchJobRegistry] Could not delete record for job ${jobId}:`,
      err,
    );
  }
}

/** Opportunistically removes records past retention. Never throws. */
function pruneStaleRecords(): void {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(REGISTRY_DIR, file);
      try {
        const record = JSON.parse(
          fs.readFileSync(filePath, 'utf-8'),
        ) as BatchJobRecord;
        if (now - record.createdAt > RECORD_RETENTION_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Unreadable record — remove it so it can't shadow a future job.
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Best-effort.
        }
      }
    }
  } catch {
    // Directory unreadable — nothing to prune.
  }
}
