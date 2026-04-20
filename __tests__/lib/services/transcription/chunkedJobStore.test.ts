import {
  ChunkedJob,
  cancelJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  getJobForUser,
  markInterruptedJobsFailed,
  updateProgress,
} from '@/lib/services/transcription/chunkedJobStore';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store hardcodes its directory; mock fs so each test sees an isolated
// in-memory layer rather than touching /tmp.
const memoryFs = new Map<string, string>();

vi.mock('fs', () => {
  const mkdirSync = vi.fn();
  const existsSync = (p: string) =>
    memoryFs.has(p) || p === '/tmp/chunked-transcription-jobs';
  const writeFileSync = (p: string, data: string) => {
    memoryFs.set(p, data);
  };
  const renameSync = (from: string, to: string) => {
    const v = memoryFs.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    memoryFs.set(to, v);
    memoryFs.delete(from);
  };
  const readFileSync = (p: string) => {
    const v = memoryFs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };
  const unlinkSync = (p: string) => {
    memoryFs.delete(p);
  };
  const readdirSync = (dir: string) =>
    [...memoryFs.keys()]
      .filter((k) => k.startsWith(dir + '/'))
      .map((k) => k.slice(dir.length + 1));

  const api = {
    mkdirSync,
    existsSync,
    writeFileSync,
    renameSync,
    readFileSync,
    unlinkSync,
    readdirSync,
  };
  return { ...api, default: api };
});

describe('chunkedJobStore', () => {
  const jobId = '11111111-2222-3333-4444-555555555555';
  const ownerId = 'owner-user';
  const otherId = 'other-user';

  beforeEach(() => {
    memoryFs.clear();
  });

  afterEach(() => {
    memoryFs.clear();
  });

  describe('createJob + getJob', () => {
    it('stores userId alongside the job', () => {
      createJob(jobId, ownerId, 2, ['/tmp/a.mp3', '/tmp/b.mp3'], 'speech.mp3');

      const job = getJob(jobId) as ChunkedJob;
      expect(job).toBeDefined();
      expect(job.userId).toBe(ownerId);
      expect(job.totalChunks).toBe(2);
      expect(job.status).toBe('pending');
    });

    it('rejects non-UUID jobIds', () => {
      expect(() => createJob('not-a-uuid', ownerId, 1, [], 'file.mp3')).toThrow(
        /Invalid job ID/,
      );
    });
  });

  describe('getJobForUser', () => {
    beforeEach(() => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
    });

    it('returns the job when the userId matches', () => {
      expect(getJobForUser(jobId, ownerId)?.userId).toBe(ownerId);
    });

    it('returns undefined when the userId does not match', () => {
      expect(getJobForUser(jobId, otherId)).toBeUndefined();
    });

    it('returns undefined when the job does not exist', () => {
      const missingId = '99999999-9999-9999-9999-999999999999';
      expect(getJobForUser(missingId, ownerId)).toBeUndefined();
    });
  });

  describe('progress mutators throw when the job is missing', () => {
    const missingId = '99999999-9999-9999-9999-999999999999';

    it('updateProgress throws', () => {
      expect(() => updateProgress(missingId, 1)).toThrow(/not found/);
    });

    it('completeJob throws', () => {
      expect(() => completeJob(missingId, 'text')).toThrow(/not found/);
    });

    it('failJob throws', () => {
      expect(() => failJob(missingId, 'err')).toThrow(/not found/);
    });
  });

  describe('failJob persists errorClass', () => {
    it('stores the provided errorClass alongside the error message', () => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
      failJob(jobId, 'Azure said no', 'auth');
      const job = getJob(jobId);
      expect(job?.errorClass).toBe('auth');
      expect(job?.error).toBe('Azure said no');
      expect(job?.status).toBe('failed');
    });

    it('leaves errorClass undefined when not provided', () => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
      failJob(jobId, 'mystery');
      expect(getJob(jobId)?.errorClass).toBeUndefined();
    });
  });

  describe('atomic writes', () => {
    it('does not leave tmp files behind after createJob', () => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
      const leftovers = [...memoryFs.keys()].filter((k) => k.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('does not leave tmp files behind after updateProgress', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      updateProgress(jobId, 1, 0);
      const leftovers = [...memoryFs.keys()].filter((k) => k.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('markInterruptedJobsFailed', () => {
    const jobA = '11111111-1111-1111-1111-111111111111';
    const jobB = '22222222-2222-2222-2222-222222222222';
    const jobC = '33333333-3333-3333-3333-333333333333';

    it('marks pending/processing jobs failed but leaves terminal jobs alone', () => {
      createJob(jobA, ownerId, 1, [], 'pending.mp3');
      createJob(jobB, ownerId, 1, [], 'processing.mp3');
      updateProgress(jobB, 0, 0);
      createJob(jobC, ownerId, 1, [], 'done.mp3');
      completeJob(jobC, 'hello');

      const marked = markInterruptedJobsFailed();

      expect(marked.sort()).toEqual([jobA, jobB].sort());
      expect(getJob(jobA)?.status).toBe('failed');
      expect(getJob(jobB)?.status).toBe('failed');
      expect(getJob(jobC)?.status).toBe('succeeded');
      expect(getJob(jobA)?.error).toMatch(/server restart/i);
    });

    it('tags interrupted jobs with errorClass=transient so clients suggest retry', () => {
      createJob(jobA, ownerId, 1, [], 'pending.mp3');
      markInterruptedJobsFailed();
      expect(getJob(jobA)?.errorClass).toBe('transient');
    });

    it('is a no-op when no jobs exist', () => {
      expect(markInterruptedJobsFailed()).toEqual([]);
    });
  });

  describe('cancelJob', () => {
    it('marks a running job as cancelled', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      cancelJob(jobId);
      expect(getJob(jobId)?.status).toBe('cancelled');
      expect(getJob(jobId)?.error).toMatch(/cancelled/i);
    });

    it('is a no-op on terminal jobs', () => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
      completeJob(jobId, 'hi');
      cancelJob(jobId);
      expect(getJob(jobId)?.status).toBe('succeeded');
    });

    it('throws when the job does not exist', () => {
      const missingId = '99999999-9999-9999-9999-999999999999';
      expect(() => cancelJob(missingId)).toThrow(/not found/);
    });
  });
});
