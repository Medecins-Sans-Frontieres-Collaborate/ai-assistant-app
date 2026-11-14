'use client';

import { useEffect, useState } from 'react';

import { formatElapsed } from '@/lib/utils/shared/translation/runProgress';

interface ElapsedTimeProps {
  /**
   * Epoch milliseconds the operation started at, for one that began before
   * this component mounted (e.g. a job resumed after a reload). Defaults to
   * the moment of mounting.
   */
  since?: number;
  className?: string;
}

/**
 * Time an operation has been running, as `m:ss`, ticking once a second.
 *
 * Mount it for the duration of the operation it times: mounting starts the
 * clock (or resumes it from `since`) and unmounting discards it, so there
 * is nothing to reset.
 */
export function ElapsedTime({ since, className }: ElapsedTimeProps) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = since ?? Date.now();
    const tick = () => setSeconds((Date.now() - startedAt) / 1000);
    // A resumed operation shows its real age at once, not after a second.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [since]);

  return (
    <span className={`tabular-nums ${className ?? ''}`}>
      {formatElapsed(seconds)}
    </span>
  );
}
