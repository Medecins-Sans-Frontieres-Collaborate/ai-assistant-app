import { Session } from 'next-auth';

import {
  JobActiveError,
  JobKind,
  JobStateBase,
  STALLED_MS,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import { personJobs } from '@/lib/services/backgroundJobs/personJobs';

import { describe, expect, it, vi } from 'vitest';

/**
 * A person's jobs of one kind, kept in their own storage: where state and
 * slots live, reading with resume, stopping, and removing.
 */

const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({
    get: async (name: string) => {
      const blob = blobs.get(name);
      if (!blob) {
        throw Object.assign(new Error('BlobNotFound'), {
          statusCode: 404,
          code: 'BlobNotFound',
        });
      }
      return blob;
    },
    upload: async (name: string, data: Buffer) => {
      blobs.set(name, data);
      return name;
    },
    deleteIfExists: async (name: string) => blobs.delete(name),
  }),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: (session: Session) => session.user?.id,
}));

interface EchoRequest {
  name: string;
}
interface EchoState extends JobStateBase {
  request: EchoRequest;
  echoed: string | null;
}

/** Waits until released, then echoes its name; runs are counted per person. */
function echoKind(gate: { release: () => void; wait: Promise<void> }) {
  const runs: string[] = [];
  const kind: JobKind<EchoRequest, EchoState, { person: string }> = {
    kind: 'echo',
    version: 1,
    limitPerPerson: 1,
    label: (request) => request.name,
    initial: () => ({ echoed: null }),
    settle: (state) => state,
    failureMessage: 'Could not echo',
    async run(job, context) {
      runs.push(context.person);
      await job.untilStopped(gate.wait);
      job.update({ echoed: job.state().request.name });
    },
  };
  return { kind, runs };
}

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}

const ALICE = { user: { id: 'alice' } } as Session;
const BOB = { user: { id: 'bob' } } as Session;

describe('personJobs', () => {
  it('keeps each job in the person’s folder, and their running jobs beside it', async () => {
    blobs.clear();
    const open = gate();
    const { kind } = echoKind(open);
    const jobs = personJobs(kind, 'echoes', (session) => ({
      person: session.user!.id!,
    }));
    const started = await jobs.start(ALICE, 'job-1', { name: 'one' });
    expect(started.status).toBe('running');
    expect([...blobs.keys()].sort()).toEqual([
      'alice/echoes/active.json',
      'alice/echoes/job-1/job.json',
    ]);
    // One slot each: a second job for Alice waits; Bob's slots are his own.
    await expect(
      jobs.start(ALICE, 'job-2', { name: 'two' }),
    ).rejects.toBeInstanceOf(JobActiveError);
    await jobs.start(BOB, 'job-3', { name: 'three' });

    open.release();
    await vi.waitFor(async () =>
      expect((await jobs.read(ALICE, 'job-1'))?.status).toBe('done'),
    );
    expect((await jobs.read(ALICE, 'job-1'))?.echoed).toBe('one');
    // Another person's key reads as nothing.
    expect(await jobs.read(BOB, 'job-1')).toBeNull();
  });

  it('picks a stalled job up again with a context made for the reader', async () => {
    blobs.clear();
    const open = gate();
    const { kind, runs } = echoKind(open);
    const jobs = personJobs(kind, 'echoes', (session) => ({
      person: session.user!.id!,
    }));
    // A job a restarted server left behind: running, its heartbeat old.
    blobs.set(
      'alice/echoes/job-9/job.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          jobId: 'old',
          status: 'running',
          startedAt: 0,
          heartbeatAt: Date.now() - STALLED_MS - 1000,
          resumes: 0,
          request: { name: 'nine' },
          echoed: null,
        }),
      ),
    );
    const resumed = await jobs.read(ALICE, 'job-9');
    expect(resumed?.resumes).toBe(1);
    open.release();
    await vi.waitFor(async () =>
      expect((await jobs.read(ALICE, 'job-9'))?.echoed).toBe('nine'),
    );
    expect(runs).toEqual(['alice']);
  });

  it('stops a job, and removes one with its slot', async () => {
    blobs.clear();
    const { kind } = echoKind(gate());
    const jobs = personJobs(kind, 'echoes', () => ({ person: 'alice' }));
    await jobs.start(ALICE, 'job-1', { name: 'one' });
    expect((await jobs.stop(ALICE, 'job-1'))?.status).toMatch(
      /running|stopped/,
    );
    await vi.waitFor(async () =>
      expect((await jobs.read(ALICE, 'job-1'))?.status).toBe('stopped'),
    );
    expect(await jobs.remove(ALICE, 'job-1')).toBe(true);
    expect([...blobs.keys()].filter((name) => name.includes('job-1'))).toEqual(
      [],
    );
    // Its slot is free again.
    await jobs.start(ALICE, 'job-2', { name: 'two' });
    expect(await jobs.remove(ALICE, 'missing')).toBe(false);
    expect(await jobs.stop(ALICE, 'missing')).toBeNull();
  });
});
