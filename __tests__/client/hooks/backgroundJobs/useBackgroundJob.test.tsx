import { act, renderHook } from '@testing-library/react';

import {
  JobFollower,
  isFollowAbort,
  useBackgroundJob,
} from '@/client/hooks/backgroundJobs/useBackgroundJob';

import { describe, expect, it, vi } from 'vitest';

/**
 * useBackgroundJob: following any kind's job until it ends, stopping it,
 * and leaving it running when the page goes.
 */

interface Reading {
  status: 'running' | 'done' | 'stopped';
  step: number;
}

/** A job that reports the given readings in turn, then the last for ever. */
function follower(readings: Reading[]): JobFollower<Reading> & {
  reads: number;
  stops: number;
} {
  const job = {
    reads: 0,
    stops: 0,
    read: vi.fn(async () => {
      const reading = readings[Math.min(job.reads, readings.length - 1)];
      job.reads += 1;
      return reading;
    }),
    stop: vi.fn(async () => {
      job.stops += 1;
      return { status: 'stopped' as const, step: -1 };
    }),
    isRunning: (reading: Reading) => reading.status === 'running',
  };
  return job;
}

describe('useBackgroundJob', () => {
  it('follows a job until it ends, passing on every reading', async () => {
    const { result } = renderHook(() =>
      useBackgroundJob<Reading>({ pollMs: 1 }),
    );
    const job = follower([
      { status: 'running', step: 1 },
      { status: 'running', step: 2 },
      { status: 'done', step: 3 },
    ]);
    const seen: number[] = [];
    let outcome: Awaited<ReturnType<typeof result.current.follow>> | undefined;
    await act(async () => {
      outcome = await result.current.follow(job, {
        onReading: (reading) => seen.push(reading.step),
      });
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(outcome).toEqual({
      last: { status: 'done', step: 3 },
      ended: true,
      error: null,
    });
    expect(result.current.following()).toBe(false);
  });

  it('starts a job, then follows it', async () => {
    const { result } = renderHook(() =>
      useBackgroundJob<Reading>({ pollMs: 1 }),
    );
    const order: string[] = [];
    const job = follower([{ status: 'done', step: 1 }]);
    job.read.mockImplementation(async () => {
      order.push('read');
      return { status: 'done', step: 1 };
    });
    await act(async () => {
      await result.current.start(async () => order.push('begin'), job);
    });
    expect(order).toEqual(['begin', 'read']);
  });

  it('stops only the job it follows', async () => {
    const { result } = renderHook(() =>
      useBackgroundJob<Reading>({ pollMs: 5 }),
    );
    expect(result.current.stop()).toBe(false);
    const job = follower([{ status: 'running', step: 1 }]);
    let following: Promise<unknown> = Promise.resolve();
    act(() => {
      following = result.current.follow(job);
    });
    await vi.waitFor(() => expect(job.reads).toBeGreaterThan(0));
    expect(result.current.stop()).toBe(true);
    await vi.waitFor(() => expect(job.stops).toBe(1));
    // The job answers stopped on its next read and the following ends.
    job.read.mockResolvedValue({ status: 'stopped', step: 2 });
    await act(async () => {
      await following;
    });
    expect(result.current.following()).toBe(false);
  });

  it('stops following, not the job, when the component goes', async () => {
    const { result, unmount } = renderHook(() =>
      useBackgroundJob<Reading>({ pollMs: 10_000 }),
    );
    const job = follower([{ status: 'running', step: 1 }]);
    let outcome: Awaited<ReturnType<typeof result.current.follow>> | undefined;
    const following = result.current.follow(job).then((value) => {
      outcome = value;
    });
    await vi.waitFor(() => expect(job.reads).toBe(1));
    unmount();
    await following;
    expect(outcome?.ended).toBe(false);
    expect(isFollowAbort(outcome?.error)).toBe(true);
    expect(job.stops).toBe(0);
  });
});
