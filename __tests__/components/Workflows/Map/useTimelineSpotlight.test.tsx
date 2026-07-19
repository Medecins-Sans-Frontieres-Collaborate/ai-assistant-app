import { act, renderHook } from '@testing-library/react';

import {
  DEFAULT_MAP_TIMELAPSE,
  cardStaggerMs,
} from '@/lib/utils/shared/geo/timelapsePacing';

import type { TimelineCue } from '@/components/Workflows/Map/useTimelinePlayback';
import { useTimelineSpotlight } from '@/components/Workflows/Map/useTimelineSpotlight';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cue = (spotlightIds: string[], index = 0): TimelineCue => ({
  index,
  total: 3,
  spotlightIds,
  dwellMs: 6000,
  cardDurationMs: DEFAULT_MAP_TIMELAPSE.cardDurationMs,
  keyframe: {
    ms: 0,
    date: { year: 2026, precision: 'year' },
    enteringIds: spotlightIds,
    exitingIds: [],
    deltaMs: 0,
  },
});

const STAGGER = cardStaggerMs(DEFAULT_MAP_TIMELAPSE.cardDurationMs);

describe('useTimelineSpotlight', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens cards one by one and closes each on its own', () => {
    // Hoisted: the cue is playback state, so its identity is stable for the
    // whole dwell — a fresh object per render would restart the schedule.
    const current = cue(['a', 'b']);
    const { result } = renderHook(() => useTimelineSpotlight(current));

    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toEqual(['a']);

    act(() => vi.advanceTimersByTime(STAGGER));
    // Overlap: the second opens while the first is still up.
    expect(result.current).toEqual(['a', 'b']);

    act(() =>
      vi.advanceTimersByTime(DEFAULT_MAP_TIMELAPSE.cardDurationMs - STAGGER),
    );
    expect(result.current).toEqual(['b']);

    act(() => vi.advanceTimersByTime(STAGGER));
    expect(result.current).toEqual([]);
  });

  it('clears everything when the cue changes', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: TimelineCue | null }) =>
        useTimelineSpotlight(current),
      { initialProps: { current: cue(['a']) as TimelineCue | null } },
    );

    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toEqual(['a']);

    rerender({ current: cue(['z'], 1) });
    expect(result.current).toEqual([]);
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toEqual(['z']);
  });

  it('shows nothing when playback stops', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: TimelineCue | null }) =>
        useTimelineSpotlight(current),
      { initialProps: { current: cue(['a']) as TimelineCue | null } },
    );
    act(() => vi.advanceTimersByTime(0));

    rerender({ current: null });
    expect(result.current).toEqual([]);
  });
});
