/**
 * File-based job records for ASYNC (batch) document translation.
 *
 * Mirrors lib/services/transcription/chunkedJobStore.ts: JSON files in
 * /tmp/document-translation-jobs/ so records survive route invocations and
 * hot reloads (single-replica only — the accepted pattern here).
 *
 * Unlike transcription there is NO background worker: Azure runs the batch;
 * this store only maps our jobId → the Azure operation id + metadata, and
 * scopes reads to the owning user. Live status always comes from Azure at
 * poll time (documentTranslationService.getBatchTranslationStatus).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TranslationJob {
  /** Our job id — also the blob-path key for original/translated files. */
  jobId: string;
  /** Owner (blob paths are already user-scoped; this scopes polling too). */
  userId: string;
  /** Azure batch operation id, polled live. */
  operationId: string;
  /** Original filename for display. */
  filename: string;
  /** Translated filename (generateTranslatedFilename output). */
  translatedFilename: string;
  /** File extension without the dot (blob path + download URL). */
  ext: string;
  targetLanguage: string;
  createdAt: number;
}

const JOB_STORE_DIR = '/tmp/document-translation-jobs';

/**
 * Keep records long enough for a client that reloads mid-translation to
 * resume polling (batch PDFs can take many minutes; blobs live 7 days —
 * 24h of job-record retention comfortably covers any realistic poll resume).
 */
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** UUID job ids only — prevents path traversal into the store dir. */
export const TRANSLATION_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jobPath(jobId: string): string {
  if (!TRANSLATION_JOB_ID_REGEX.test(jobId)) {
    throw new Error('Invalid translation job id');
  }
  return path.join(JOB_STORE_DIR, `${jobId}.json`);
}

function ensureDir(): void {
  fs.mkdirSync(JOB_STORE_DIR, { recursive: true, mode: 0o700 });
}

export function createTranslationJob(job: TranslationJob): void {
  ensureDir();
  const target = jobPath(job.jobId);
  // tmp-then-rename for atomic writes (chunkedJobStore pattern).
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(tmp, target);
  sweepExpiredJobs();
}

/**
 * Reads a job scoped to its owner. Returns undefined for missing jobs AND
 * ownership mismatches (indistinguishable — prevents job-id enumeration).
 */
export function getTranslationJobForUser(
  jobId: string,
  userId: string,
): TranslationJob | undefined {
  if (!TRANSLATION_JOB_ID_REGEX.test(jobId)) return undefined;
  try {
    const raw = fs.readFileSync(jobPath(jobId), 'utf8');
    const job = JSON.parse(raw) as TranslationJob;
    return job.userId === userId ? job : undefined;
  } catch {
    return undefined;
  }
}

export function deleteTranslationJob(jobId: string): void {
  try {
    fs.unlinkSync(jobPath(jobId));
  } catch {
    // Already gone — fine.
  }
}

/** Opportunistic cleanup of expired records (runs on each create). */
function sweepExpiredJobs(): void {
  try {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const entry of fs.readdirSync(JOB_STORE_DIR)) {
      if (!entry.endsWith('.json')) continue;
      const full = path.join(JOB_STORE_DIR, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // Raced with another sweep — fine.
      }
    }
  } catch {
    // Store dir missing — nothing to sweep.
  }
}
