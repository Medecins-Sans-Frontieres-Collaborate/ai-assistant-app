import {
  RenderBusyError,
  RenderLane,
  RenderQueue,
} from '@/lib/services/documents/render/renderQueue';

import { describe, expect, it, vi } from 'vitest';

/** A task that runs until released, recording when it started. */
function gate(log: string[], name: string) {
  let release!: (value: string) => void;
  let fail!: (error: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const task = () => {
    log.push(name);
    return done;
  };
  return { task, release: () => release(name), fail: (e: Error) => fail(e) };
}

/** Lets settled promises run their callbacks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const queueOf = (
  overrides: Partial<ConstructorParameters<typeof RenderQueue>[0]> = {},
) =>
  new RenderQueue({
    maxConcurrent: 1,
    maxQueued: 10,
    interactiveBurst: 2,
    ...overrides,
  });

describe('RenderQueue', () => {
  it('runs no more than maxConcurrent jobs at once', async () => {
    const queue = queueOf({ maxConcurrent: 2 });
    const log: string[] = [];
    const jobs = ['a', 'b', 'c'].map((name) => gate(log, name));
    const results = jobs.map((job) => queue.run('translation', job.task));

    await flush();
    expect(log).toEqual(['a', 'b']); // at the cap: two run, the third waits
    expect(queue.snapshot()).toEqual({
      running: 2,
      queued: { interactive: 0, translation: 1 },
    });

    jobs[0].release();
    await flush();
    expect(log).toEqual(['a', 'b', 'c']);
    jobs[1].release();
    jobs[2].release();
    await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c']);
    expect(queue.snapshot().running).toBe(0);
  });

  it('puts interactive work first, but lets translation in after a burst', async () => {
    const queue = queueOf({ interactiveBurst: 2 });
    const log: string[] = [];
    const first = gate(log, 'first');
    queue.run('translation', first.task);
    const waiting: Array<[RenderLane, string]> = [
      ['translation', 't1'],
      ['interactive', 'i1'],
      ['interactive', 'i2'],
      ['interactive', 'i3'],
    ];
    const gates = waiting.map(([lane, name]) => {
      const job = gate(log, name);
      queue.run(lane, job.task);
      return job;
    });

    for (const job of [first, ...gates]) {
      job.release();
      await flush();
    }
    // Two interactive jobs, then the waiting translation job, then the rest.
    expect(log).toEqual(['first', 'i1', 'i2', 't1', 'i3']);
  });

  it('holds exactly maxQueued waiting jobs, then refuses', async () => {
    const queue = queueOf({ maxQueued: 2 });
    const log: string[] = [];
    const running = gate(log, 'running');
    queue.run('translation', running.task);
    queue.run('translation', gate(log, 'w1').task);
    queue.run('interactive', gate(log, 'w2').task);

    const refused = vi.fn();
    const busy = new RenderQueue({
      maxConcurrent: 1,
      maxQueued: 0,
      interactiveBurst: 1,
      observer: { onRefused: refused },
    });
    busy.run('translation', gate(log, 'only').task);

    await expect(
      queue.run('translation', gate(log, 'w3').task),
    ).rejects.toBeInstanceOf(RenderBusyError);
    await expect(
      busy.run('interactive', gate(log, 'x').task),
    ).rejects.toMatchObject({ code: 'RENDER_BUSY' });
    expect(refused).toHaveBeenCalledWith('interactive');
    expect(log).not.toContain('w3');
  });

  it('drops a job aborted while waiting, and never runs it', async () => {
    const queue = queueOf();
    const log: string[] = [];
    const running = gate(log, 'running');
    queue.run('translation', running.task);
    const controller = new AbortController();
    const aborted = queue.run('translation', gate(log, 'aborted').task, {
      signal: controller.signal,
    });

    controller.abort(new Error('stopped'));
    await expect(aborted).rejects.toThrow('stopped');
    expect(queue.snapshot().queued.translation).toBe(0);
    running.release();
    await flush();
    expect(log).toEqual(['running']);
  });

  it('frees the slot when a job fails', async () => {
    const queue = queueOf();
    const log: string[] = [];
    const failing = gate(log, 'failing');
    const failed = queue.run('translation', failing.task);
    const next = gate(log, 'next');
    const after = queue.run('translation', next.task);

    failing.fail(new Error('crashed'));
    await expect(failed).rejects.toThrow('crashed');
    await flush();
    next.release();
    await expect(after).resolves.toBe('next');
  });

  it('tells a waiting job how many are ahead, and 0 when it starts', async () => {
    const queue = queueOf();
    const log: string[] = [];
    const running = gate(log, 'running');
    queue.run('translation', running.task);
    const first = gate(log, 'first');
    queue.run('translation', first.task);
    const positions: number[] = [];
    queue.run('translation', gate(log, 'mine').task, {
      onPosition: (ahead) => positions.push(ahead),
    });
    // Interactive work arriving later counts as ahead of translation work.
    const interactive = gate(log, 'chat');
    queue.run('interactive', interactive.task);

    expect(positions).toEqual([2, 3]);
    running.release();
    await flush(); // chat runs (interactive first)
    interactive.release();
    await flush(); // first runs
    first.release();
    await flush(); // mine runs
    expect(positions.at(-1)).toBe(0);
  });

  it('reports each job to the observer', async () => {
    const onStart = vi.fn();
    const onFinish = vi.fn();
    const queue = queueOf({ observer: { onStart, onFinish } });
    await queue.run('interactive', async () => 'done');
    await expect(
      queue.run('translation', async () => {
        throw new Error('bad');
      }),
    ).rejects.toThrow('bad');
    expect(onStart).toHaveBeenCalledWith('interactive', 0);
    expect(onFinish.mock.calls.map((call) => call[2])).toEqual(['ok', 'error']);
  });

  it('refuses settings that would never run anything', () => {
    expect(() => queueOf({ maxConcurrent: 0 })).toThrow('maxConcurrent');
    expect(() => queueOf({ interactiveBurst: 0 })).toThrow('interactiveBurst');
  });
});
