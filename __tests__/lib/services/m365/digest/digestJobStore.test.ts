import {
  DIGEST_JOB_RETENTION_MS,
  DigestBusyError,
  STALE_DIGEST_JOB_MS,
  claimActiveDigest,
  createDigestJob,
  deleteDigestJobForUser,
  getDigestJobForUser,
  mutateActiveDigestJob,
  releaseActiveDigest,
} from '@/lib/services/m365/digest/digestJobStore';

import type { BlobStorage } from '@/lib/utils/server/blob/blob';

import type { DigestJob } from '@/types/m365Digest';

import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

function memory() {
  const records = new Map<string, { bytes: Buffer; etag: string }>();
  let version = 0;
  const storage = {
    deleteIfExists: async (path: string) => records.delete(path),
    getBlockBlobClient: (path: string) => ({
      upload: async (
        bytes: Buffer,
        _len: number,
        options?: { conditions?: { ifMatch?: string; ifNoneMatch?: string } },
      ) => {
        const current = records.get(path);
        const conditions = options?.conditions;
        if (conditions?.ifNoneMatch === '*' && current)
          throw { statusCode: 409 };
        if (conditions?.ifMatch && current?.etag !== conditions.ifMatch)
          throw { statusCode: 412 };
        const etag = `v${++version}`;
        records.set(path, { bytes: Buffer.from(bytes), etag });
        return { etag };
      },
      download: async () => {
        const current = records.get(path);
        if (!current) throw { statusCode: 404 };
        return {
          readableStreamBody: Readable.from([current.bytes]),
          etag: current.etag,
        };
      },
      getProperties: async () => {
        const current = records.get(path);
        if (!current) throw { statusCode: 404 };
        return { etag: current.etag };
      },
      deleteIfExists: async () => ({ succeeded: records.delete(path) }),
      exists: async () => records.has(path),
    }),
  } as unknown as BlobStorage;
  return { storage, records };
}

const jobId = '11111111-2222-4333-8444-555555555555';
const job = (now: number): DigestJob => ({
  jobId,
  userId: 'u1',
  status: 'pending',
  request: {
    window: { startIso: 'a', endIso: 'b', preset: '7d' },
    sources: ['mail'],
    channels: [],
  },
  progress: { stage: 'starting', sources: [] },
  createdAt: now,
  updatedAt: now,
});

describe('digestJobStore', () => {
  afterEach(() => vi.useRealTimers());

  it('round-trips a job and hides it from other users', async () => {
    const { storage } = memory();
    await createDigestJob(storage, job(Date.now()));
    expect((await getDigestJobForUser(storage, 'u1', jobId))?.status).toBe(
      'pending',
    );
    expect(
      await getDigestJobForUser(storage, 'someone-else', jobId),
    ).toBeUndefined();
  });

  it('mutates active jobs and leaves terminal ones alone', async () => {
    const { storage } = memory();
    await createDigestJob(storage, job(Date.now()));
    const processing = await mutateActiveDigestJob(
      storage,
      'u1',
      jobId,
      (current) => {
        current.status = 'processing';
        current.progress.stage = 'scanning';
      },
    );
    expect(processing?.progress.stage).toBe('scanning');
    await mutateActiveDigestJob(storage, 'u1', jobId, (current) => {
      current.status = 'failed';
      current.error = 'boom';
    });
    const late = await mutateActiveDigestJob(
      storage,
      'u1',
      jobId,
      (current) => {
        current.status = 'succeeded';
      },
    );
    expect(late).toBeNull();
    expect((await getDigestJobForUser(storage, 'u1', jobId))?.status).toBe(
      'failed',
    );
  });

  it('lazily fails a stale in-flight job at poll time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { storage } = memory();
    await createDigestJob(storage, job(Date.now()));
    vi.setSystemTime(1_000_000 + STALE_DIGEST_JOB_MS + 1);
    const polled = await getDigestJobForUser(storage, 'u1', jobId);
    expect(polled?.status).toBe('failed');
    expect(polled?.error).toBeTruthy();
  });

  it('allows one live digest per user, takes over stale or finished ones, releases only its own marker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { storage } = memory();
    const second = '22222222-2222-4333-8444-555555555555';
    await claimActiveDigest(storage, 'u1', jobId);
    await createDigestJob(storage, job(Date.now()));
    await expect(
      claimActiveDigest(storage, 'u1', second),
    ).rejects.toBeInstanceOf(DigestBusyError);
    // Another user is unaffected.
    await expect(
      claimActiveDigest(storage, 'u2', second),
    ).resolves.toBeUndefined();
    // A stale first job is taken over.
    vi.setSystemTime(1_000_000 + STALE_DIGEST_JOB_MS + 1);
    await expect(
      claimActiveDigest(storage, 'u1', second),
    ).resolves.toBeUndefined();
    // Releasing the old job does not clear the newer claim.
    await releaseActiveDigest(storage, 'u1', jobId);
    await createDigestJob(storage, { ...job(Date.now()), jobId: second });
    const third = '33333333-2222-4333-8444-555555555555';
    await expect(
      claimActiveDigest(storage, 'u1', third),
    ).rejects.toBeInstanceOf(DigestBusyError);
    await releaseActiveDigest(storage, 'u1', second);
    await expect(
      claimActiveDigest(storage, 'u1', third),
    ).resolves.toBeUndefined();
  });

  it("deletes only the owner's record", async () => {
    const { storage, records } = memory();
    await createDigestJob(storage, job(Date.now()));
    expect(await deleteDigestJobForUser(storage, 'someone-else', jobId)).toBe(
      false,
    );
    expect(records.size).toBe(1);
    expect(await deleteDigestJobForUser(storage, 'u1', jobId)).toBe(true);
    expect(records.size).toBe(0);
    expect(await deleteDigestJobForUser(storage, 'u1', jobId)).toBe(false);
  });

  it('expires jobs past retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { storage, records } = memory();
    await createDigestJob(storage, job(Date.now()));
    vi.setSystemTime(1_000_000 + DIGEST_JOB_RETENTION_MS + 1);
    expect(await getDigestJobForUser(storage, 'u1', jobId)).toBeUndefined();
    expect(records.size).toBe(0);
  });
});
