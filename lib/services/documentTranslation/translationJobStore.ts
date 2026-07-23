/**
 * Blob-backed job records for ASYNC (batch) document translation.
 *
 * Records live in blob storage next to the translation blobs themselves
 * (`{userId}/translations/jobs/{jobId}.json`), so any replica can serve a
 * status poll — the live container app runs min_replicas = 2, which is
 * exactly what broke the previous /tmp-file store (polls hitting a replica
 * other than the one that accepted the submit returned NOT_FOUND).
 *
 * There is NO background worker: Azure runs the batch; this store only maps
 * our jobId → the Azure operation id + metadata, and scopes reads to the
 * owning user. Live status always comes from Azure at poll time
 * (documentTranslationService.getBatchTranslationStatus). Records are
 * cleaned up by the storage account's lifecycle management policy along with
 * the translation blobs they describe.
 */
import { BlobProperty, BlobStorage } from '@/lib/utils/server/blob/blob';

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

/** UUID job ids only — prevents path traversal into the jobs prefix. */
export const TRANSLATION_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `jobs/` segment keeps records out of the way of the translation blobs
 * (`{userId}/translations/{jobId}.{ext}`), which the content route serves.
 */
function jobBlobPath(userId: string, jobId: string): string {
  if (!TRANSLATION_JOB_ID_REGEX.test(jobId)) {
    throw new Error('Invalid translation job id');
  }
  return `${userId}/translations/jobs/${jobId}.json`;
}

export async function createTranslationJob(
  storage: BlobStorage,
  job: TranslationJob,
): Promise<void> {
  await storage.upload(
    jobBlobPath(job.userId, job.jobId),
    JSON.stringify(job),
    {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    },
  );
}

/**
 * Reads a job scoped to its owner. Returns undefined for missing jobs AND
 * ownership mismatches (indistinguishable — prevents job-id enumeration).
 * The path is already user-scoped; the userId check is defense in depth.
 */
export async function getTranslationJobForUser(
  storage: BlobStorage,
  jobId: string,
  userId: string,
): Promise<TranslationJob | undefined> {
  if (!TRANSLATION_JOB_ID_REGEX.test(jobId)) return undefined;
  try {
    const raw = await storage.get(
      jobBlobPath(userId, jobId),
      BlobProperty.BLOB,
    );
    const job = JSON.parse(raw.toString()) as TranslationJob;
    return job.userId === userId ? job : undefined;
  } catch {
    return undefined;
  }
}
