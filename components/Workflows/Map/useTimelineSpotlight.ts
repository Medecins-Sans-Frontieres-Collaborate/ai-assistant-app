'use client';

import { useEffect, useState } from 'react';

import { cardStaggerMs } from '@/lib/utils/shared/geo/timelapsePacing';

import type { TimelineCue } from './useTimelinePlayback';

const NONE: string[] = [];

/**
 * Which features have an auto-opened card RIGHT NOW.
 *
 * During each dwell the cue's features open one after another and close on
 * their own, with the stagger a fraction of the lifetime so consecutive
 * cards overlap — the effect is someone clicking through the new arrivals,
 * not a slideshow advancing one frame at a time. Both durations come from
 * the cue, so they match the dwell the playback hook budgeted.
 *
 * Open cards are stored against the cue that scheduled them, so a jump (or a
 * pause) drops the previous keyframe's cards at render time. Resetting them
 * from inside the effect instead would cascade an extra render on every
 * keyframe.
 */
export function useTimelineSpotlight(cue: TimelineCue | null): string[] {
  const [open, setOpen] = useState<{ cue: TimelineCue | null; ids: string[] }>({
    cue: null,
    ids: NONE,
  });

  useEffect(() => {
    if (!cue) return;

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    // Ids accumulate only against this cue; a state entry left by the
    // previous keyframe is replaced rather than appended to.
    const update = (change: (ids: string[]) => string[]) =>
      setOpen((current) => ({
        cue,
        ids: change(current.cue === cue ? current.ids : NONE),
      }));

    const stagger = cardStaggerMs(cue.cardDurationMs);
    cue.spotlightIds.forEach((id, index) => {
      const openAt = index * stagger;
      timers.push(
        setTimeout(
          () => update((ids) => (ids.includes(id) ? ids : [...ids, id])),
          openAt,
        ),
      );
      timers.push(
        setTimeout(
          () => update((ids) => ids.filter((shown) => shown !== id)),
          openAt + cue.cardDurationMs,
        ),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, [cue]);

  return cue && open.cue === cue ? open.ids : NONE;
}
