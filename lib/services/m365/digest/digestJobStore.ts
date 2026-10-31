/**
 * Blob-backed state for digest jobs: `{userId}/m365-digest-jobs/{jobId}.json`
 * in the user-data container, compare-and-swap on the blob ETag with bounded
 * re-read-and-reapply on 412 — the chunkedJobStore discipline, so any
 * replica can serve a poll and a terminal status can never be overwritten
 * by a late progress write. Processing itself is pinned to the replica
 * that started the job; a job whose loop stops heartbeating is failed
 * lazily at poll time (STALE_DIGEST_JOB_MS).
 *
 * Digest results contain mailbox and chat text. They live only as long as
 * DIGEST_JOB_RETENTION_MS; an expired record is deleted on read.
 */
import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import type { DigestJob } from '@/types/m365Digest';

export const DIGEST_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No progress write for this long ⇒ the processing replica is gone. */
export const STALE_DIGEST_JOB_MS = 3 * 60_000;
/** Results are mailbox content: keep them only long enough to be collected. */
export const DIGEST_JOB_RETENTION_MS = 24 * 60 * 60_000;
export const DIGEST_JOB_INTERRUPTED_MESSAGE =
  'The digest was interrupted before it finished. Run it again.';

const CAS_MAX_ATTEMPTS = 4;

/** Thrown by {@link claimActiveDigest} while another digest of the user is still running. */
export class DigestBusyError extends Error {
  constructor(readonly activeJobId: string) {
    super('A digest is already running; wait for it to finish.');
    this.name = 'DigestBusyError';
  }
}

/** Soft marker of the user's live digest; jobs are detached 90 s runs, so one at a time. */
export function activeDigestMarkerPath(userId: string): string {
  return `${userId}/m365-digest-jobs/active.json`;
}

export function digestJobBlobPath(userId: string, jobId: string): string {
  if (!DIGEST_JOB_ID_REGEX.test(jobId)) {
    throw new Error('Invalid digest job id');
  }
  return `${userId}/m365-digest-jobs/${jobId}.json`;
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (data) =>
      chunks.push(data instanceof Buffer ? data : Buffer.from(data)),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function readBlob(
  storage: BlobStorage,
  blobPath: string,
): Promise<{ job: DigestJob; etag: string } | null> {
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
          job: JSON.parse(buffer.toString('utf8')) as DigestJob,
          etag: response.etag ?? '',
        };
      },
      { label: 'digestJobStore.read' },
    );
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

async function writeBlob(
  storage: BlobStorage,
  blobPath: string,
  job: DigestJob,
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
    { label: 'digestJobStore.write' },
  );
}

export async function createDigestJob(
  storage: BlobStorage,
  job: DigestJob,
): Promise<void> {
  await writeBlob(storage, digestJobBlobPath(job.userId, job.jobId), job, null);
}

interface ActiveMarker {
  jobId: string;
  claimedAt: number;
}

async function readMarker(
  storage: BlobStorage,
  userId: string,
): Promise<ActiveMarker | null> {
  const client = storage.getBlockBlobClient(activeDigestMarkerPath(userId));
  try {
    const response = await client.download();
    if (!response.readableStreamBody) return null;
    const parsed = JSON.parse(
      (await streamToBuffer(response.readableStreamBody)).toString('utf8'),
    ) as Partial<ActiveMarker>;
    return typeof parsed.jobId === 'string' &&
      DIGEST_JOB_ID_REGEX.test(parsed.jobId)
      ? { jobId: parsed.jobId, claimedAt: Number(parsed.claimedAt) || 0 }
      : null;
  } catch (error) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

/**
 * Records `jobId` as the user's live digest. Throws DigestBusyError when the
 * marker names a job that is still pending/processing and heartbeating; a
 * stale or terminal marker is simply taken over (the marker is advisory —
 * the per-day counter is the hard budget).
 */
export async function claimActiveDigest(
  storage: BlobStorage,
  userId: string,
  jobId: string,
  now: number = Date.now(),
): Promise<void> {
  const marker = await readMarker(storage, userId);
  if (marker && marker.jobId !== jobId) {
    const record = await readBlob(
      storage,
      digestJobBlobPath(userId, marker.jobId),
    );
    const job = record?.job;
    const live =
      !!job &&
      (job.status === 'pending' || job.status === 'processing') &&
      now - job.updatedAt <= STALE_DIGEST_JOB_MS;
    if (live) throw new DigestBusyError(marker.jobId);
  }
  const client = storage.getBlockBlobClient(activeDigestMarkerPath(userId));
  const content = Buffer.from(
    JSON.stringify({ jobId, claimedAt: now } satisfies ActiveMarker),
    'utf8',
  );
  await withAzureRetry(
    () =>
      client.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      }),
    { label: 'digestJobStore.claim' },
  );
}

/** Clears the marker if it still names `jobId` (a newer claim is left alone). */
export async function releaseActiveDigest(
  storage: BlobStorage,
  userId: string,
  jobId: string,
): Promise<void> {
  try {
    const marker = await readMarker(storage, userId);
    if (marker?.jobId !== jobId) return;
    await storage.deleteIfExists(activeDigestMarkerPath(userId));
  } catch (error) {
    console.warn(
      '[digestJobStore] Could not release the active-digest marker:',
      sanitizeForLog(jobId),
      error,
    );
  }
}

/** Deletes the caller's job record (any status); foreign or unknown ids are no-ops. */
export async function deleteDigestJobForUser(
  storage: BlobStorage,
  userId: string,
  jobId: string,
): Promise<boolean> {
  if (!DIGEST_JOB_ID_REGEX.test(jobId)) return false;
  const blobPath = digestJobBlobPath(userId, jobId);
  const record = await readBlob(storage, blobPath);
  if (!record || record.job.userId !== userId) return false;
  await storage.deleteIfExists(blobPath);
  return true;
}

/**
 * The caller's job, or undefined when missing, expired, or owned by
 * someone else (indistinguishable on purpose). Fails a job whose loop
 * stopped writing progress so the poller sees a terminal state.
 */
export async function getDigestJobForUser(
  storage: BlobStorage,
  userId: string,
  jobId: string,
): Promise<DigestJob | undefined> {
  if (!DIGEST_JOB_ID_REGEX.test(jobId)) return undefined;
  const blobPath = digestJobBlobPath(userId, jobId);
  const record = await readBlob(storage, blobPath);
  if (!record || record.job.userId !== userId) return undefined;
  if (Date.now() - record.job.createdAt > DIGEST_JOB_RETENTION_MS) {
    try {
      await storage.deleteIfExists(blobPath);
    } catch (error) {
      console.warn(
        '[digestJobStore] Could not delete expired job:',
        sanitizeForLog(jobId),
        error,
      );
    }
    return undefined;
  }
  const { job, etag } = record;
  const active = job.status === 'pending' || job.status === 'processing';
  if (active && Date.now() - job.updatedAt > STALE_DIGEST_JOB_MS) {
    const failed: DigestJob = {
      ...job,
      status: 'failed',
      error: DIGEST_JOB_INTERRUPTED_MESSAGE,
      updatedAt: Date.now(),
    };
    try {
      await writeBlob(storage, blobPath, failed, etag);
    } catch (error) {
      if (statusCodeOf(error) !== 412) {
        console.warn(
          '[digestJobStore] Could not persist stale-job failure:',
          sanitizeForLog(jobId),
          error,
        );
      }
    }
    return failed;
  }
  return job;
}

/**
 * Read-check-apply-write for an ACTIVE job (terminal states are never
 * touched). `apply` mutates a copy; returns the written job or null when
 * the job is terminal/missing.
 */
export async function mutateActiveDigestJob(
  storage: BlobStorage,
  userId: string,
  jobId: string,
  apply: (job: DigestJob) => void,
): Promise<DigestJob | null> {
  const blobPath = digestJobBlobPath(userId, jobId);
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const record = await readBlob(storage, blobPath);
    if (!record) return null;
    if (record.job.status !== 'pending' && record.job.status !== 'processing') {
      return null;
    }
    const next: DigestJob = structuredClone(record.job);
    apply(next);
    next.updatedAt = Date.now();
    try {
      await writeBlob(storage, blobPath, next, record.etag);
      return next;
    } catch (error) {
      if (statusCodeOf(error) !== 412) throw error;
    }
  }
  throw new Error('Digest job was modified concurrently too many times');
}
