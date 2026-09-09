/**
 * Concurrency limiter shared by every M365 path that fans out to Graph.
 *
 * Lives here rather than in the mail composites (its first home) so a route
 * can bound its own fan-out without importing the composite module graph —
 * which pulls in next-auth, the screening pipeline and an OpenAI client.
 */

/**
 * Returns a `schedule` function admitting at most `max` concurrent tasks.
 * Waiters re-check the count in a loop rather than assuming the wake-up
 * handed them the slot: several can be resolved before any of them runs.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async function schedule<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}
