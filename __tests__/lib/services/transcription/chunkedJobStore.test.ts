import {
  ChunkedJob,
  cancelJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  getJobForUser,
  markInterruptedJobsFailed,
  sweepOrphanedChunkDirs,
  updateProgress,
} from '@/lib/services/transcription/chunkedJobStore';

import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store hardcodes its directory; mock fs so each test sees an isolated
// in-memory layer rather than touching /tmp.
const memoryFs = new Map<string, string>();

vi.mock('fs', () => {
  // Lock dirs created by acquireJobLock; tracked so re-acquisition conflicts
  // behave like the real fs (mkdirSync throws when the dir exists).
  const dirs = new Set<string>();
  const mkdirSync = vi.fn((p: string, opts?: { recursive?: boolean }) => {
    if (dirs.has(p) && !opts?.recursive) {
      throw new Error(`EEXIST: ${p}`);
    }
    dirs.add(p);
  });
  const rmdirSync = vi.fn((p: string) => {
    dirs.delete(p);
  });
  const statSync = vi.fn((p: string) => {
    if (!dirs.has(p) && !memoryFs.has(p)) throw new Error(`ENOENT: ${p}`);
    return { mtimeMs: Date.now() };
  });
  const rmSync = vi.fn((p: string) => {
    dirs.delete(p);
    for (const key of [...memoryFs.keys()]) {
      if (key === p || key.startsWith(p + '/')) memoryFs.delete(key);
    }
  });
  const existsSync = (p: string) =>
    memoryFs.has(p) || dirs.has(p) || p === '/tmp/chunked-transcription-jobs';
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
    if (!memoryFs.delete(p)) throw new Error(`ENOENT: ${p}`);
  };
  const readdirSync = (dir: string, opts?: { withFileTypes?: boolean }) => {
    const names = new Set<string>();
    for (const key of [...memoryFs.keys(), ...dirs]) {
      if (key.startsWith(dir + '/')) {
        names.add(key.slice(dir.length + 1).split('/')[0]);
      }
    }
    if (!opts?.withFileTypes) return [...names];
    return [...names].map((name) => ({
      name,
      isDirectory: () =>
        dirs.has(`${dir}/${name}`) ||
        [...memoryFs.keys()].some((k) => k.startsWith(`${dir}/${name}/`)),
    }));
  };

  const api = {
    mkdirSync,
    rmdirSync,
    statSync,
    rmSync,
    existsSync,
    writeFileSync,
    renameSync,
    readFileSync,
    unlinkSync,
    readdirSync,
  };
  return { ...api, default: api };
});

// Helper: clear the lock-dir registry between tests via rmSync on root paths.
function seedFile(path: string, content = 'x'): void {
  memoryFs.set(path, content);
}

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

    it('removes the interrupted job’s chunk files and per-job dir', () => {
      const chunkDir = `${os.tmpdir()}/chunked-transcription/${jobA}`;
      const chunkPaths = [`${chunkDir}/audio_chunk_000.mp3`];
      seedFile(chunkPaths[0]);
      createJob(jobA, ownerId, 1, chunkPaths, 'pending.mp3');

      markInterruptedJobsFailed();

      // Status reconciled AND disk reclaimed — interrupted chunks can never
      // be consumed by the (now dead) in-process pipeline.
      expect(getJob(jobA)?.status).toBe('failed');
      expect(memoryFs.has(chunkPaths[0])).toBe(false);
    });
  });

  describe('sweepOrphanedChunkDirs', () => {
    const activeJob = '11111111-1111-1111-1111-111111111111';
    const doneJob = '22222222-2222-2222-2222-222222222222';

    it('removes dirs without a live job record, keeps active ones', () => {
      const root = `${os.tmpdir()}/chunked-transcription`;
      seedFile(`${root}/${activeJob}/a_chunk_000.mp3`);
      seedFile(`${root}/${doneJob}/b_chunk_000.mp3`);
      seedFile(`${root}/no-record-at-all/c_chunk_000.mp3`);

      createJob(activeJob, ownerId, 1, [], 'active.mp3');
      createJob(doneJob, ownerId, 1, [], 'done.mp3');
      completeJob(doneJob, 'transcript');

      const removed = sweepOrphanedChunkDirs();

      expect(removed.sort()).toEqual([doneJob, 'no-record-at-all'].sort());
      expect(memoryFs.has(`${root}/${activeJob}/a_chunk_000.mp3`)).toBe(true);
      expect(memoryFs.has(`${root}/${doneJob}/b_chunk_000.mp3`)).toBe(false);
      expect(memoryFs.has(`${root}/no-record-at-all/c_chunk_000.mp3`)).toBe(
        false,
      );
    });

    it('is a no-op when the chunk root does not exist', () => {
      expect(sweepOrphanedChunkDirs()).toEqual([]);
    });
  });

  describe('cancelJob', () => {
    it('marks a running job as cancelled', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      cancelJob(jobId);
      expect(getJob(jobId)?.status).toBe('cancelled');
      expect(getJob(jobId)?.error).toMatch(/cancelled/i);
    });

    it('is a no-op on a succeeded job', () => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
      completeJob(jobId, 'hi');
      cancelJob(jobId);
      expect(getJob(jobId)?.status).toBe('succeeded');
    });

    it('is a no-op on an already-cancelled job', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      cancelJob(jobId);
      const firstUpdatedAt = getJob(jobId)?.updatedAt;
      cancelJob(jobId);
      expect(getJob(jobId)?.status).toBe('cancelled');
      // updatedAt stays pinned to the original cancel write — no re-save.
      expect(getJob(jobId)?.updatedAt).toBe(firstUpdatedAt);
    });

    it('is a no-op on a failed job', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      failJob(jobId, 'boom', 'permanent');
      cancelJob(jobId);
      expect(getJob(jobId)?.status).toBe('failed');
      expect(getJob(jobId)?.error).toBe('boom');
    });

    it('throws when the job does not exist', () => {
      const missingId = '99999999-9999-9999-9999-999999999999';
      expect(() => cancelJob(missingId)).toThrow(/not found/);
    });
  });

  describe('terminal state is preserved against late writes', () => {
    // A background chunk that finishes after the user cancelled (or after
    // failJob ran) must not clobber the terminal status. These tests pin
    // that invariant so the cancel-race fix doesn't regress.
    it('updateProgress is a no-op once a job is cancelled', () => {
      createJob(jobId, ownerId, 3, [], 'file.mp3');
      cancelJob(jobId);
      updateProgress(jobId, 2, 1);
      const job = getJob(jobId);
      expect(job?.status).toBe('cancelled');
      expect(job?.completedChunks).toBe(0);
    });

    it('updateProgress is a no-op once a job has failed', () => {
      createJob(jobId, ownerId, 3, [], 'file.mp3');
      failJob(jobId, 'boom', 'permanent');
      updateProgress(jobId, 2, 1);
      expect(getJob(jobId)?.status).toBe('failed');
    });

    it('completeJob is a no-op once a job is cancelled', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      cancelJob(jobId);
      completeJob(jobId, 'the finished transcript');
      const job = getJob(jobId);
      expect(job?.status).toBe('cancelled');
      expect(job?.transcript).toBeUndefined();
    });

    it('failJob is a no-op once a job is cancelled', () => {
      createJob(jobId, ownerId, 2, [], 'file.mp3');
      cancelJob(jobId);
      failJob(jobId, 'late chunk error', 'transient');
      const job = getJob(jobId);
      expect(job?.status).toBe('cancelled');
      // The cancel message is preserved; the late-failure error never lands.
      expect(job?.error).toMatch(/cancelled/i);
      expect(job?.errorClass).toBeUndefined();
    });

    it('failJob is a no-op once a job has succeeded', () => {
      createJob(jobId, ownerId, 1, [], 'file.mp3');
      completeJob(jobId, 'transcript');
      failJob(jobId, 'late error', 'transient');
      const job = getJob(jobId);
      expect(job?.status).toBe('succeeded');
      expect(job?.transcript).toBe('transcript');
    });
  });
});
