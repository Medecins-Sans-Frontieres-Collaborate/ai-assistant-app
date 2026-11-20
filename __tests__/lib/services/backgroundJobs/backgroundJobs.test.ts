import {
  ABANDONED_MS,
  JobActiveError,
  JobKind,
  JobSlotRecord,
  JobSlots,
  JobStateBase,
  JobStore,
  STALLED_MS,
  isStalled,
  jobInProcess,
  readJob,
  resumeJob,
  startJob,
  stopJob,
} from '@/lib/services/backgroundJobs/backgroundJobs';
import { BlobJobSlots } from '@/lib/services/backgroundJobs/blobJobSlots';

import { describe, expect, it } from 'vitest';

/**
 * THE JOB CONVENTION (backgroundJobs.ts) on a small kind: a job counts to
 * its target one stored step at a time, so a resumed job goes on from the
 * last stored step and a stop keeps what was counted.
 */

interface CountRequest {
  name: string;
  target: number;
}
interface CountState extends JobStateBase {
  request: CountRequest;
  counted: number;
  /** Only meaningful while running. */
  current?: number;
}
interface CountContext {
  /** Steps done in this process, to show none is repeated. */
  done: number[];
  /** Resolves to let each step finish; a step waits for it. */
  gate?: () => Promise<void>;
  failAt?: number;
}

const COUNT: JobKind<CountRequest, CountState, CountContext> = {
  kind: 'count',
  version: 1,
  limitPerPerson: 2,
  label: (request) => request.name,
  initial: () => ({ counted: 0, current: 1 }),
  settle: (state) => ({ ...state, current: undefined }),
  failureMessage: 'Could not count',
  async run(job, context) {
    for (
      let n = job.state().counted + 1;
      n <= job.state().request.target;
      n++
    ) {
      job.signal.throwIfAborted();
      job.update({ current: n });
      await job.save();
      if (context.gate) await job.untilStopped(context.gate());
      if (context.failAt === n) throw new Error(`no ${n}`);
      context.done.push(n);
      job.update({ counted: n });
      await job.save();
    }
  },
};

function memoryStore(): JobStore & { state: unknown; stop: boolean } {
  const store = {
    state: null as unknown,
    stop: false,
    getJob: async () => store.state,
    putJob: async (state: unknown) => {
      store.state = state;
    },
    stopRequested: async () => store.stop,
    requestStop: async () => {
      store.stop = true;
    },
    clearStop: async () => {
      store.stop = false;
    },
  };
  return store;
}

function memorySlots(initial: JobSlotRecord[] = []): JobSlots & {
  records: JobSlotRecord[];
} {
  const slots = {
    records: [...initial],
    read: async () => [...slots.records],
    write: async (record: JobSlotRecord) => {
      slots.records = [
        ...slots.records.filter((held) => held.key !== record.key),
        record,
      ];
    },
    release: async (key: string) => {
      slots.records = slots.records.filter((held) => held.key !== key);
    },
  };
  return slots;
}

let keys = 0;
const nextKey = () => `job-${(keys += 1)}`;

describe('startJob', () => {
  it('answers at once with the stored state, then does the work', async () => {
    const store = memoryStore();
    const slots = memorySlots();
    const key = nextKey();
    const context: CountContext = { done: [] };
    const first = await startJob(
      COUNT,
      { store, slots, key, context },
      { name: 'Report', target: 3 },
    );
    expect(first).toMatchObject({ status: 'running', counted: 0, resumes: 0 });
    expect(slots.records.map((r) => r.label)).toEqual(['Report']);

    const final = await jobInProcess<CountState>('count', key);
    expect(context.done).toEqual([1, 2, 3]);
    expect(final).toMatchObject({ status: 'done', counted: 3 });
    expect(final?.current).toBeUndefined();
    expect(store.state).toMatchObject({ status: 'done' });
    expect(slots.records).toEqual([]);
  });

  it('records a failure with its message, keeps what was done, frees the slot', async () => {
    const store = memoryStore();
    const slots = memorySlots();
    const key = nextKey();
    await startJob(
      COUNT,
      { store, slots, key, context: { done: [], failAt: 2 } },
      { name: 'Report', target: 3 },
    );
    const final = await jobInProcess<CountState>('count', key);
    expect(final).toMatchObject({
      status: 'failed',
      error: 'no 2',
      counted: 1,
    });
    expect(slots.records).toEqual([]);
  });
});

describe('active jobs per person and kind', () => {
  const now = 1_000_000_000;
  const held = (key: string, heartbeatAt = now): JobSlotRecord => ({
    key,
    label: key,
    heartbeatAt,
  });
  const place = (slots: JobSlots) => ({
    store: memoryStore(),
    slots,
    key: nextKey(),
    context: { done: [], gate: () => new Promise<void>(() => undefined) },
    clock: { now: () => now },
  });

  it('allows up to the kind’s limit and refuses the next, naming one in the way', async () => {
    const slots = memorySlots([held('a')]);
    await startJob(COUNT, place(slots), { name: 'Second', target: 1 });
    await expect(
      startJob(COUNT, place(slots), { name: 'Third', target: 1 }),
    ).rejects.toMatchObject({ name: 'JobActiveError', active: { key: 'a' } });
  });

  it('does not count a job not heard from for ABANDONED_MS', async () => {
    const slots = memorySlots([
      held('a', now - ABANDONED_MS - 1),
      held('b', now - ABANDONED_MS - 1),
    ]);
    await expect(
      startJob(COUNT, place(slots), { name: 'New', target: 1 }),
    ).resolves.toMatchObject({ status: 'running' });
  });

  it('refuses before storing anything', async () => {
    const slots = memorySlots([held('a'), held('b')]);
    const refused = place(slots);
    await expect(
      startJob(COUNT, refused, { name: 'New', target: 1 }),
    ).rejects.toBeInstanceOf(JobActiveError);
    expect(refused.store.state).toBeNull();
  });
});

describe('a restart', () => {
  const now = 2_000_000_000;
  const stored = (heartbeatAt: number): CountState => ({
    version: 1,
    jobId: 'j',
    request: { name: 'Report', target: 4 },
    status: 'running',
    counted: 2,
    current: 3,
    startedAt: now - 10 * STALLED_MS,
    heartbeatAt,
    resumes: 0,
  });

  it('is stalled only when its heartbeat is older than STALLED_MS', () => {
    expect(isStalled('count', 'x', stored(now - STALLED_MS - 1), now)).toBe(
      true,
    );
    expect(isStalled('count', 'x', stored(now - STALLED_MS + 1), now)).toBe(
      false,
    );
    expect(isStalled('count', 'x', { ...stored(0), status: 'done' }, now)).toBe(
      false,
    );
  });

  it('goes on from the last stored step without repeating any', async () => {
    const store = memoryStore();
    const key = nextKey();
    const context: CountContext = { done: [] };
    const resumed = await resumeJob(
      COUNT,
      { store, slots: memorySlots(), key, context, clock: { now: () => now } },
      stored(now - STALLED_MS - 1),
    );
    expect(resumed).toMatchObject({ resumes: 1, current: undefined });
    const final = await jobInProcess<CountState>('count', key);
    expect(context.done).toEqual([3, 4]);
    expect(final).toMatchObject({ status: 'done', counted: 4 });
  });

  it('leaves a job with a fresh heartbeat alone', async () => {
    const fresh = stored(now - 1000);
    const store = memoryStore();
    const key = nextKey();
    await expect(
      resumeJob(
        COUNT,
        {
          store,
          slots: memorySlots(),
          key,
          context: { done: [] },
          clock: { now: () => now },
        },
        fresh,
      ),
    ).resolves.toBe(fresh);
    expect(jobInProcess('count', key)).toBeUndefined();
  });
});

describe('stopping', () => {
  it('stops a job running here at once, keeping what was done', async () => {
    const store = memoryStore();
    const key = nextKey();
    // Two steps go through; the third waits for ever.
    let passed = 0;
    let reachedThird: () => void = () => undefined;
    const third = new Promise<void>((resolve) => (reachedThird = resolve));
    const context: CountContext = {
      done: [],
      gate: () => {
        passed += 1;
        if (passed <= 2) return Promise.resolve();
        reachedThird();
        return new Promise<void>(() => undefined);
      },
    };
    const state = await startJob(
      COUNT,
      { store, slots: memorySlots(), key, context },
      { name: 'Report', target: 5 },
    );
    await third;
    const stopping = await stopJob(COUNT, key, store, state);
    expect(stopping.stopRequested).toBe(true);
    const final = await jobInProcess<CountState>('count', key);
    expect(final).toMatchObject({
      status: 'stopped',
      stopRequested: true,
      counted: 2,
    });
    expect(context.done).toEqual([1, 2]);
  });

  it('stops a job run by another instance at its next heartbeat', async () => {
    const store = memoryStore();
    const key = nextKey();
    await startJob(
      COUNT,
      {
        store,
        slots: memorySlots(),
        key,
        context: { done: [], gate: () => new Promise<void>(() => undefined) },
        clock: { heartbeatMs: 5 },
      },
      { name: 'Report', target: 2 },
    );
    // Another instance only writes the marker.
    store.stop = true;
    const final = await jobInProcess<CountState>('count', key);
    expect(final).toMatchObject({ status: 'stopped' });
  });

  it('a new job is not stopped by an old stop marker', async () => {
    const store = memoryStore();
    store.stop = true;
    const key = nextKey();
    await startJob(
      COUNT,
      {
        store,
        slots: memorySlots(),
        key,
        context: { done: [] },
        clock: { heartbeatMs: 1 },
      },
      { name: 'Report', target: 2 },
    );
    const final = await jobInProcess<CountState>('count', key);
    expect(final).toMatchObject({ status: 'done', counted: 2 });
  });
});

describe('readJob', () => {
  it('reads only a state of the kind’s version', async () => {
    const store = memoryStore();
    store.state = { version: 2, status: 'running' };
    await expect(readJob(COUNT, store)).resolves.toBeNull();
    store.state = { version: 1, status: 'done' };
    await expect(readJob(COUNT, store)).resolves.toMatchObject({
      status: 'done',
    });
  });
});

describe('BlobJobSlots', () => {
  function memoryBlob(initial?: string) {
    const blobs = new Map<string, Buffer>();
    if (initial !== undefined) blobs.set('u/slots.json', Buffer.from(initial));
    const notFound = Object.assign(new Error('not found'), {
      statusCode: 404,
      code: 'BlobNotFound',
    });
    return {
      blobs,
      storage: {
        get: async (name: string) => {
          const blob = blobs.get(name);
          if (!blob) throw notFound;
          return blob;
        },
        // Written whole, as files that change in place are (overwriteBlob.ts).
        getBlockBlobClient: (name: string) => ({
          upload: async (data: Buffer) => blobs.set(name, Buffer.from(data)),
        }),
        deleteIfExists: async (name: string) => {
          blobs.delete(name);
        },
      } as never,
    };
  }

  it('reads a slot kept in the old single-record shape', async () => {
    const { storage } = memoryBlob(
      JSON.stringify({
        runId: 'run-1',
        backend: 'app',
        sourceName: 'Deck.pptx',
        heartbeatAt: 5,
      }),
    );
    const slots = new BlobJobSlots(storage, 'u', 'slots.json');
    await expect(slots.read()).resolves.toEqual([
      {
        key: 'run-1',
        label: 'Deck.pptx',
        heartbeatAt: 5,
        data: { backend: 'app' },
      },
    ]);
  });

  it('keeps several records, replaces by key and removes the blob with the last', async () => {
    const { storage, blobs } = memoryBlob();
    const slots = new BlobJobSlots(storage, 'u', 'slots.json');
    await expect(slots.read()).resolves.toEqual([]);
    await slots.write({ key: 'a', label: 'A', heartbeatAt: 1 });
    await slots.write({ key: 'b', label: 'B', heartbeatAt: 1 });
    await slots.write({ key: 'a', label: 'A', heartbeatAt: 2 });
    expect((await slots.read()).map((r) => [r.key, r.heartbeatAt])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    await slots.release('a');
    await slots.release('b');
    expect(blobs.has('u/slots.json')).toBe(false);
  });
});
