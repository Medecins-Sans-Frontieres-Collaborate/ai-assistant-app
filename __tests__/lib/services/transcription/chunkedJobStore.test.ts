/**
 * Tests for the blob-backed chunked transcription job store.
 *
 * Runs against an in-memory fake BlobStorage with ETag simulation (etag
 * bumps on every write; ifMatch / ifNoneMatch honored like Azure) so the
 * CAS semantics — the part that replaced the old fs advisory lock — are
 * exercised for real rather than mocked away.
 */
import {
  ChunkedJob,
  JOB_CANCELLED_MESSAGE,
  JOB_INTERRUPTED_MESSAGE,
  STALE_JOB_MS,
  cancelJob,
  completeJob,
  createJob,
  deleteJob,
  failJob,
  getJob,
  getJobForUser,
  updateProgress,
} from '@/lib/services/transcription/chunkedJobStore';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredBlob {
  content: string;
  etag: number;
}

function azureError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * In-memory stand-in for the subset of BlobStorage the store uses:
 * getBlockBlobClient().download/upload (with ETag conditions) and
 * deleteIfExists. `onBeforeUpload` fires inside upload BEFORE the
 * precondition check, letting tests inject a competing write to force a 412
 * deterministically.
 */
class FakeBlobStorage {
  blobs = new Map<string, StoredBlob>();
  uploadAttempts: string[] = [];
  deletedPaths: string[] = [];
  onBeforeUpload: ((blobName: string) => void) | null = null;
  private nextEtag = 1;

  getBlockBlobClient(blobName: string) {
    return {
      download: async () => {
        const blob = this.blobs.get(blobName);
        if (!blob) throw azureError(404, `BlobNotFound: ${blobName}`);
        return {
          etag: `"${blob.etag}"`,
          readableStreamBody: Readable.from([
            Buffer.from(blob.content, 'utf8'),
          ]),
        };
      },
      upload: async (
        content: Buffer,
        _length: number,
        options?: {
          conditions?: { ifMatch?: string; ifNoneMatch?: string };
        },
      ) => {
        this.uploadAttempts.push(blobName);
        this.onBeforeUpload?.(blobName);
        const existing = this.blobs.get(blobName);
        const conditions = options?.conditions ?? {};
        if (conditions.ifNoneMatch === '*' && existing) {
          throw azureError(409, `BlobAlreadyExists: ${blobName}`);
        }
        if (conditions.ifMatch !== undefined) {
          if (!existing || `"${existing.etag}"` !== conditions.ifMatch) {
            throw azureError(412, `ConditionNotMet: ${blobName}`);
          }
        }
        this.setRaw(blobName, content.toString('utf8'));
        return { etag: `"${this.blobs.get(blobName)!.etag}"` };
      },
    };
  }

  async deleteIfExists(blobName: string): Promise<boolean> {
    this.deletedPaths.push(blobName);
    return this.blobs.delete(blobName);
  }

  /** Direct write bypassing conditions — simulates another writer winning. */
  setRaw(blobName: string, content: string): void {
    this.blobs.set(blobName, { content, etag: this.nextEtag++ });
  }

  readJson(blobName: string): ChunkedJob | undefined {
    const blob = this.blobs.get(blobName);
    return blob ? (JSON.parse(blob.content) as ChunkedJob) : undefined;
  }
}

const jobId = '11111111-2222-3333-4444-555555555555';
const ownerId = 'owner-user';
const otherId = 'other-user';
const jobPath = `${ownerId}/transcription-jobs/${jobId}.json`;

describe('chunkedJobStore (blob-backed)', () => {
  let fake: FakeBlobStorage;
  let storage: BlobStorage;

  beforeEach(() => {
    vi.restoreAllMocks();
    fake = new FakeBlobStorage();
    storage = fake as unknown as BlobStorage;
  });

  async function createOwnedJob(
    totalChunks = 2,
    chunkPaths: string[] = ['/tmp/a.mp3', '/tmp/b.mp3'],
  ): Promise<void> {
    await createJob(storage, jobId, ownerId, totalChunks, chunkPaths, 'a.mp3');
  }

  /** Rewrites a stored field directly, preserving CAS realism elsewhere. */
  function patchStoredJob(patch: Partial<ChunkedJob>): void {
    const job = fake.readJson(jobPath);
    expect(job).toBeDefined();
    fake.setRaw(jobPath, JSON.stringify({ ...job, ...patch }));
  }

  describe('createJob + getJob', () => {
    it('stores the record at the user-scoped path', async () => {
      await createOwnedJob();

      expect(fake.blobs.has(jobPath)).toBe(true);
      const job = (await getJob(storage, jobId, ownerId)) as ChunkedJob;
      expect(job.userId).toBe(ownerId);
      expect(job.totalChunks).toBe(2);
      expect(job.status).toBe('pending');
    });

    it('refuses to overwrite an existing record (ifNoneMatch: *)', async () => {
      await createOwnedJob();
      await expect(createOwnedJob()).rejects.toThrow(/BlobAlreadyExists/);
    });

    it('returns undefined for a missing job', async () => {
      const missingId = '99999999-9999-9999-9999-999999999999';
      expect(await getJob(storage, missingId, ownerId)).toBeUndefined();
    });
  });

  describe('JOB_ID_REGEX path guard', () => {
    it('createJob rejects non-UUID jobIds before touching storage', async () => {
      await expect(
        createJob(storage, '../escape', ownerId, 1, [], 'x.mp3'),
      ).rejects.toThrow(/Invalid job ID/);
      expect(fake.uploadAttempts).toEqual([]);
    });

    it('getJob treats a malformed id as not found without a blob read', async () => {
      expect(await getJob(storage, 'not-a-uuid', ownerId)).toBeUndefined();
    });

    it('getJobForUser treats a traversal-shaped id as not found', async () => {
      expect(
        await getJobForUser(storage, '../../${otherId}/x', ownerId),
      ).toBeUndefined();
    });

    it('mutations reject malformed ids', async () => {
      await expect(updateProgress(storage, 'nope', ownerId, 1)).rejects.toThrow(
        /Invalid job ID/,
      );
    });
  });

  describe('getJobForUser ownership', () => {
    beforeEach(async () => {
      await createOwnedJob();
    });

    it('returns the job for the owner', async () => {
      const job = await getJobForUser(storage, jobId, ownerId);
      expect(job?.userId).toBe(ownerId);
    });

    it('returns undefined for another user (path-scoped: no record there)', async () => {
      expect(await getJobForUser(storage, jobId, otherId)).toBeUndefined();
    });

    it('returns undefined when the stored userId mismatches the path owner', async () => {
      // Defense in depth: a record planted under the wrong prefix is refused.
      patchStoredJob({ userId: otherId });
      expect(await getJobForUser(storage, jobId, ownerId)).toBeUndefined();
    });
  });

  describe('mutations', () => {
    it('updateProgress bumps progress and updatedAt', async () => {
      await createOwnedJob(3, []);
      const before = fake.readJson(jobPath)!.updatedAt;
      vi.spyOn(Date, 'now').mockReturnValue(before + 1234);

      await updateProgress(storage, jobId, ownerId, 1, 1);

      const job = fake.readJson(jobPath)!;
      expect(job.status).toBe('processing');
      expect(job.completedChunks).toBe(1);
      expect(job.currentChunk).toBe(1);
      expect(job.updatedAt).toBe(before + 1234);
    });

    it('completeJob stores the transcript and marks succeeded', async () => {
      await createOwnedJob(2, []);
      await completeJob(storage, jobId, ownerId, 'the text');
      const job = fake.readJson(jobPath)!;
      expect(job.status).toBe('succeeded');
      expect(job.transcript).toBe('the text');
      expect(job.completedChunks).toBe(2);
    });

    it('failJob persists error and errorClass', async () => {
      await createOwnedJob(1, []);
      await failJob(storage, jobId, ownerId, 'Azure said no', 'auth');
      const job = fake.readJson(jobPath)!;
      expect(job.status).toBe('failed');
      expect(job.error).toBe('Azure said no');
      expect(job.errorClass).toBe('auth');
    });

    it('mutations throw when the job is missing', async () => {
      const missingId = '99999999-9999-9999-9999-999999999999';
      await expect(
        updateProgress(storage, missingId, ownerId, 1),
      ).rejects.toThrow(/not found/);
      await expect(
        completeJob(storage, missingId, ownerId, 'text'),
      ).rejects.toThrow(/not found/);
      await expect(failJob(storage, missingId, ownerId, 'err')).rejects.toThrow(
        /not found/,
      );
      await expect(cancelJob(storage, missingId, ownerId)).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('CAS retry on 412', () => {
    it('re-reads and re-applies when a concurrent updateProgress wins the race', async () => {
      await createOwnedJob(3, []);

      // Simulate a sibling worker (possibly another replica) landing its
      // progress write between this call's read and write: the first upload
      // attempt hits a bumped etag, 412s, and the retry applies on top of
      // the fresh state.
      let injected = false;
      fake.onBeforeUpload = () => {
        if (injected) return;
        injected = true;
        const job = fake.readJson(jobPath)!;
        fake.setRaw(
          jobPath,
          JSON.stringify({
            ...job,
            status: 'processing',
            completedChunks: 1,
            currentChunk: 0,
          }),
        );
      };

      await updateProgress(storage, jobId, ownerId, 2, 2);

      const job = fake.readJson(jobPath)!;
      expect(job.completedChunks).toBe(2);
      expect(job.currentChunk).toBe(2);
      // First attempt 412'd, second succeeded.
      expect(fake.uploadAttempts.filter((p) => p === jobPath).length).toBe(3); // create + 2 CAS attempts
    });

    it('a lost race against cancelJob leaves the job cancelled (no clobber)', async () => {
      await createOwnedJob(3, []);

      let injected = false;
      fake.onBeforeUpload = () => {
        if (injected) return;
        injected = true;
        const job = fake.readJson(jobPath)!;
        fake.setRaw(
          jobPath,
          JSON.stringify({
            ...job,
            status: 'cancelled',
            error: JOB_CANCELLED_MESSAGE,
          }),
        );
      };

      // The CAS retry re-reads, sees the terminal state, and no-ops.
      await updateProgress(storage, jobId, ownerId, 1, 0);

      const job = fake.readJson(jobPath)!;
      expect(job.status).toBe('cancelled');
      expect(job.completedChunks).toBe(0);
    });
  });

  describe('cancelJob (cooperative cancel between chunks)', () => {
    it('marks a running job cancelled; the loop then observes it via getJob', async () => {
      await createOwnedJob(3, []);
      await updateProgress(storage, jobId, ownerId, 1, 1);

      await cancelJob(storage, jobId, ownerId);

      // This is exactly the read the processing loop performs between
      // chunks (isJobCancelled) — it must see the cancellation.
      const observed = await getJob(storage, jobId, ownerId);
      expect(observed?.status).toBe('cancelled');
      expect(observed?.error).toBe(JOB_CANCELLED_MESSAGE);
    });

    it('is a no-op on a succeeded job', async () => {
      await createOwnedJob(1, []);
      await completeJob(storage, jobId, ownerId, 'hi');
      await cancelJob(storage, jobId, ownerId);
      expect(fake.readJson(jobPath)!.status).toBe('succeeded');
    });

    it('late progress/completion after cancel cannot resurrect the job', async () => {
      await createOwnedJob(2, []);
      await cancelJob(storage, jobId, ownerId);

      await updateProgress(storage, jobId, ownerId, 2, 1);
      await completeJob(storage, jobId, ownerId, 'late transcript');
      await failJob(storage, jobId, ownerId, 'late error', 'transient');

      const job = fake.readJson(jobPath)!;
      expect(job.status).toBe('cancelled');
      expect(job.transcript).toBeUndefined();
      expect(job.error).toBe(JOB_CANCELLED_MESSAGE);
    });
  });

  describe('stale-processing lazy failure (restart semantics)', () => {
    it('transforms a silent in-flight job to failed/transient at poll time and persists it', async () => {
      await createOwnedJob(3, []);
      await updateProgress(storage, jobId, ownerId, 1, 1);
      patchStoredJob({ updatedAt: Date.now() - STALE_JOB_MS - 1 });

      const polled = await getJobForUser(storage, jobId, ownerId);

      expect(polled?.status).toBe('failed');
      expect(polled?.error).toBe(JOB_INTERRUPTED_MESSAGE);
      expect(polled?.errorClass).toBe('transient');

      // Persisted, not just transformed in-flight.
      const stored = fake.readJson(jobPath)!;
      expect(stored.status).toBe('failed');
      expect(stored.error).toBe(JOB_INTERRUPTED_MESSAGE);
    });

    it('leaves a recently-updated processing job alone', async () => {
      await createOwnedJob(3, []);
      await updateProgress(storage, jobId, ownerId, 1, 1);

      const polled = await getJobForUser(storage, jobId, ownerId);
      expect(polled?.status).toBe('processing');
    });

    it('leaves terminal jobs alone regardless of age', async () => {
      await createOwnedJob(1, []);
      await completeJob(storage, jobId, ownerId, 'done');
      patchStoredJob({ updatedAt: Date.now() - STALE_JOB_MS * 10 });

      const polled = await getJobForUser(storage, jobId, ownerId);
      expect(polled?.status).toBe('succeeded');
      expect(polled?.transcript).toBe('done');
    });

    it('still returns the failed transform when the persist loses a CAS race', async () => {
      await createOwnedJob(3, []);
      patchStoredJob({
        status: 'processing',
        updatedAt: Date.now() - STALE_JOB_MS - 1,
      });

      // Competing write between the poll's read and its persist: the 412 is
      // swallowed, the stored (fresh) record is untouched, and the caller
      // still gets the transformed view for THIS poll.
      let injected = false;
      fake.onBeforeUpload = () => {
        if (injected) return;
        injected = true;
        const job = fake.readJson(jobPath)!;
        fake.setRaw(jobPath, JSON.stringify({ ...job, updatedAt: Date.now() }));
      };

      const polled = await getJobForUser(storage, jobId, ownerId);
      expect(polled?.status).toBe('failed');
      // The competing (alive) record won the write.
      expect(fake.readJson(jobPath)!.status).toBe('processing');
    });
  });

  describe('lazy retention deletion', () => {
    it('treats a record older than 24h as gone and deletes it best-effort', async () => {
      await createOwnedJob(1, []);
      await completeJob(storage, jobId, ownerId, 'old transcript');
      patchStoredJob({ createdAt: Date.now() - 25 * 60 * 60 * 1000 });

      expect(await getJob(storage, jobId, ownerId)).toBeUndefined();
      expect(fake.deletedPaths).toContain(jobPath);
      expect(fake.blobs.has(jobPath)).toBe(false);
    });

    it('keeps a record younger than 24h', async () => {
      await createOwnedJob(1, []);
      await completeJob(storage, jobId, ownerId, 'recent');
      patchStoredJob({ createdAt: Date.now() - 23 * 60 * 60 * 1000 });

      const job = await getJob(storage, jobId, ownerId);
      expect(job?.transcript).toBe('recent');
    });
  });

  describe('deleteJob', () => {
    it('removes the record idempotently', async () => {
      await createOwnedJob(1, []);
      await deleteJob(storage, jobId, ownerId);
      expect(fake.blobs.has(jobPath)).toBe(false);
      // Second delete is a silent no-op.
      await deleteJob(storage, jobId, ownerId);
    });
  });
});
