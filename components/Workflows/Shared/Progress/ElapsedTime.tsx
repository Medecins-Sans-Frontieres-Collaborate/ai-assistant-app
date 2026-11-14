'use client';

import { useEffect, useState } from 'react';

import { formatElapsed } from '@/lib/utils/shared/translation/runProgress';

interface ElapsedTimeProps {
  className?: string;
}

/**
 * Time since this component mounted, as `m:ss`, ticking once a second.
 *
 * Mount it for the duration of the operation it times: mounting starts the
 * clock and unmounting discards it, so there is nothing to reset.
 */
export function ElapsedTime({ className }: ElapsedTimeProps) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(
      () => setSeconds((Date.now() - startedAt) / 1000),
      1000,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <span className={`tabular-nums ${className ?? ''}`}>
      {formatElapsed(seconds)}
    </span>
  );
}
