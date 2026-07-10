'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  TimelineScale,
  msToStep,
  stepToMs,
} from '@/lib/utils/shared/geo/timelineScale';

/** Normal playback tick; the scale caps at ~240 steps ≈ ≤36s per sweep. */
const TICK_MS = 150;
/**
 * Reduced-motion tick: slower, so appearance/disappearance reads as
 * discrete state changes rather than animation.
 */
const REDUCED_MOTION_TICK_MS = 600;

/**
 * Time-lapse playback state. `timeMs === null` means timeline mode is off
 * (live view). Scrubbing pauses playback; playing from the end restarts.
 * Ticks advance one STEP of the piecewise scale — the gap between eras
 * costs exactly one tick.
 */
export function useTimelinePlayback(scale: TimelineScale | null): {
  timeMs: number | null;
  setTimeMs: (ms: number | null) => void;
  playing: boolean;
  togglePlay: () => void;
} {
  const [timeMs, setTimeMsState] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPlaying(false);
  }, []);

  // Manual scrub (or timeline off) pauses playback.
  const setTimeMs = useCallback(
    (ms: number | null) => {
      stop();
      setTimeMsState(ms);
    },
    [stop],
  );

  const togglePlay = useCallback(() => {
    if (!scale) return;
    if (playing) {
      stop();
      return;
    }
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = reducedMotion ? REDUCED_MOTION_TICK_MS : TICK_MS;

    setTimeMsState((current) => {
      // Play from the start when off or already at the end.
      if (current === null || current >= scale.maxMs) return scale.minMs;
      return current;
    });
    setPlaying(true);
    intervalRef.current = setInterval(() => {
      setTimeMsState((current) => {
        const index = msToStep(scale, current ?? scale.minMs);
        if (index + 1 >= scale.totalSteps) {
          stop();
          return scale.maxMs;
        }
        return stepToMs(scale, index + 1);
      });
    }, tick);
  }, [scale, playing, stop]);

  // Scale changed (filters altered the dated set) or unmount: stop cleanly.
  useEffect(() => stop, [scale, stop]);

  return { timeMs, setTimeMs, playing, togglePlay };
}
