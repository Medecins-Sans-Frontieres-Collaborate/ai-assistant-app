'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MapTimelapseSettings,
  keyframeDwellMs,
  sampleSpotlight,
} from '@/lib/utils/shared/geo/timelapsePacing';
import { TimelineKeyframe } from '@/lib/utils/shared/geo/timelineKeyframes';
import { TimelineScale } from '@/lib/utils/shared/geo/timelineScale';

/**
 * What the map is showing while playback dwells on one keyframe: the date
 * it jumped to, how far it jumped, and which features to auto-open.
 */
export interface TimelineCue {
  index: number;
  total: number;
  keyframe: TimelineKeyframe;
  /** Features to spotlight during this dwell (already sampled). */
  spotlightIds: string[];
  /** How long this keyframe is held. */
  dwellMs: number;
  /** Card lifetime in force for this dwell (see `useTimelineSpotlight`). */
  cardDurationMs: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Time-lapse playback. `timeMs === null` means timeline mode is off (live
 * view). Scrubbing pauses; playing from the end restarts.
 *
 * Playback is KEYFRAME-driven, not step-driven: it visits only the instants
 * where the active set actually changes (see `timelineKeyframes.ts`) and
 * holds each one while its cards play out. Empty stretches — which a linear
 * sweep spends most of its runtime on — collapse into a single announced
 * jump. Busy dates are held longer than quiet ones. The slider still runs on
 * the scale's step indices, so the thumb tracks the sweep and manual
 * scrubbing stays smooth.
 *
 * `pacing` is read at the moment each keyframe starts, so dragging the
 * duration slider mid-sweep takes effect on the next date rather than
 * restarting playback.
 */
export function useTimelinePlayback(
  scale: TimelineScale | null,
  keyframes: TimelineKeyframe[],
  pacing: MapTimelapseSettings,
): {
  timeMs: number | null;
  setTimeMs: (ms: number | null) => void;
  playing: boolean;
  togglePlay: () => void;
  cue: TimelineCue | null;
} {
  const [timeMs, setTimeMsState] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cue, setCue] = useState<TimelineCue | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref so a pacing change doesn't rebuild the running chain.
  const pacingRef = useRef(pacing);
  useEffect(() => {
    pacingRef.current = pacing;
  }, [pacing]);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
    setCue(null);
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
    if (!scale || keyframes.length === 0) return;
    if (playing) {
      stop();
      return;
    }
    const reducedMotion = prefersReducedMotion();
    const last = keyframes[keyframes.length - 1];
    // Resume at the next keyframe ahead of the current time; start over when
    // the timeline is off or the sweep already finished.
    const next =
      timeMs === null || timeMs >= last.ms
        ? 0
        : keyframes.findIndex((frame) => frame.ms > timeMs);

    setPlaying(true);
    // Recursive rather than an interval: each keyframe earns its own dwell
    // from how much it has to show.
    const step = (index: number) => {
      const keyframe = keyframes[index];
      const { cardDurationMs, maxCardsPerDate } = pacingRef.current;
      const spotlightIds = sampleSpotlight(
        keyframe.enteringIds,
        maxCardsPerDate,
      );
      const dwellMs = keyframeDwellMs({
        cardCount: spotlightIds.length,
        arrivalCount: keyframe.enteringIds.length,
        cardDurationMs,
        reducedMotion,
      });
      setTimeMsState(keyframe.ms);
      setCue({
        index,
        total: keyframes.length,
        keyframe,
        spotlightIds,
        dwellMs,
        cardDurationMs,
      });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (index + 1 >= keyframes.length) {
          setPlaying(false);
          setCue(null);
          return;
        }
        step(index + 1);
      }, dwellMs);
    };
    step(next === -1 ? 0 : next);
  }, [scale, keyframes, playing, timeMs, stop]);

  // Scale or keyframes changed (filters altered the dated set), or unmount:
  // stop cleanly rather than stepping through a stale list.
  useEffect(() => stop, [scale, keyframes, stop]);

  return { timeMs, setTimeMs, playing, togglePlay, cue };
}
