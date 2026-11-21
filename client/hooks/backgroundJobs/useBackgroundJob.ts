'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * The browser's side of any background job (THE JOB CONVENTION in
 * lib/services/backgroundJobs/backgroundJobs.ts): start it, follow its
 * progress until it ends, follow it again after a reload (reattach), and
 * ask it to stop. The work goes on on the server whether or not the page
 * is open; leaving the page only stops following.
 */

/** How a kind's job is read and stopped from the browser. */
export interface JobFollower<Reading> {
  /** Reads the job (a stalled job is picked up again by the read). */
  read(signal: AbortSignal): Promise<Reading>;
  /** Asks the job to stop; it is followed until it has. */
  stop(): Promise<Reading>;
  /** Whether the reading says the job is still going. */
  isRunning(reading: Reading): boolean;
}

/** How following a job ended. */
export interface FollowOutcome<Reading> {
  /** The last reading, if any was made. */
  last: Reading | null;
  /** The job ended (done, failed or stopped) rather than being left. */
  ended: boolean;
  /** What stopped the following, if it was not the job ending. */
  error: unknown;
}

/** How often a running job is read. */
export const JOB_POLL_MS = 2_000;

/** Waits, unless stopped first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Whether an error is a stop of the following (an abort). */
export function isFollowAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * Follows background jobs from a component.
 *
 * @param options.pollMs - How often a running job is read (JOB_POLL_MS).
 * @returns `follow` (follow a job until it ends, also one remembered from
 *   before a reload), `start` (start one, then follow it), `stop` (ask the
 *   followed job to stop; false when none is followed) and `following`.
 *   Following stops when the component unmounts; the job does not.
 * @example
 *   const jobs = useBackgroundJob<DeckJobReading>();
 *   const outcome = await jobs.start(() => startDeckJob(input), deckFollower(run), {
 *     onReading: (reading) => setProgress(progressOf(reading)),
 *   });
 */
export function useBackgroundJob<Reading>(options: { pollMs?: number } = {}) {
  const pollMs = options.pollMs ?? JOB_POLL_MS;
  const followed = useRef<JobFollower<Reading> | null>(null);
  const unmounted = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    unmounted.current = controller;
    return () => controller.abort();
  }, []);

  const follow = useCallback(
    async (
      follower: JobFollower<Reading>,
      handlers: {
        onReading?: (reading: Reading) => void;
        signal?: AbortSignal;
      } = {},
    ): Promise<FollowOutcome<Reading>> => {
      const signal = handlers.signal
        ? AbortSignal.any([handlers.signal, unmounted.current.signal])
        : unmounted.current.signal;
      followed.current = follower;
      let last: Reading | null = null;
      try {
        for (;;) {
          last = await follower.read(signal);
          handlers.onReading?.(last);
          if (!follower.isRunning(last))
            return { last, ended: true, error: null };
          await pause(pollMs, signal);
        }
      } catch (error) {
        return { last, ended: false, error };
      } finally {
        if (followed.current === follower) followed.current = null;
      }
    },
    [pollMs],
  );

  const start = useCallback(
    async (
      begin: () => Promise<unknown>,
      follower: JobFollower<Reading>,
      handlers: {
        onReading?: (reading: Reading) => void;
        signal?: AbortSignal;
      } = {},
    ): Promise<FollowOutcome<Reading>> => {
      await begin();
      return follow(follower, handlers);
    },
    [follow],
  );

  const stop = useCallback((onError?: (error: unknown) => void): boolean => {
    const follower = followed.current;
    if (!follower) return false;
    void follower.stop().catch((error: unknown) => onError?.(error));
    return true;
  }, []);

  const following = useCallback(() => followed.current !== null, []);

  return useMemo(
    () => ({ follow, start, stop, following }),
    [follow, start, stop, following],
  );
}
