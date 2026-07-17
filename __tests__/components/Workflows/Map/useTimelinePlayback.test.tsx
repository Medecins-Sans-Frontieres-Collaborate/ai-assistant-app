import { act, renderHook } from '@testing-library/react';

import {
  TimelineScale,
  computeTimelineScale,
  stepToMs,
} from '@/lib/utils/shared/geo/timelineScale';

import { MapFeature } from '@/types/workflow';

import { useTimelinePlayback } from '@/components/Workflows/Map/useTimelinePlayback';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const feature = (overrides: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...overrides,
});

const NOW = Date.UTC(2026, 5, 10);

/** 2 sparse historical eras + a dense burst. */
function scale(): TimelineScale {
  return computeTimelineScale(
    [
      feature({ id: 'h1', eventStart: '1812' }),
      feature({ id: 'e1', eventStart: '2026-05-01' }),
      feature({ id: 'e2', eventStart: '2026-05-10' }),
      feature({ id: 'e3', eventStart: '2026-05-20', eventOngoing: true }),
    ],
    NOW,
  ) as TimelineScale;
}

function stubMatchMedia(reducedMotion: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: reducedMotion }),
  );
  window.matchMedia = vi.fn().mockReturnValue({
    matches: reducedMotion,
  }) as unknown as typeof window.matchMedia;
}

describe('useTimelinePlayback (piecewise steps)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('advances exactly one step per tick, gaps included', () => {
    const s = scale();
    const { result } = renderHook(() => useTimelinePlayback(s));

    act(() => result.current.togglePlay());
    expect(result.current.timeMs).toBe(s.minMs);

    // Step 0 → 1: still inside the sparse 1812 era (its end).
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.timeMs).toBe(stepToMs(s, 1));

    // Step 1 → 2 crosses the 200-year gap in ONE tick.
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.timeMs).toBe(stepToMs(s, 2));
    expect(result.current.timeMs).toBe(s.segments[1].startMs);
  });

  it('stops at the final step (= maxMs)', () => {
    const s = scale();
    const { result } = renderHook(() => useTimelinePlayback(s));
    act(() => result.current.togglePlay());
    act(() => vi.advanceTimersByTime(150 * (s.totalSteps + 5)));
    expect(result.current.timeMs).toBe(s.maxMs);
    expect(result.current.playing).toBe(false);
  });

  it('manual scrub pauses playback', () => {
    const s = scale();
    const { result } = renderHook(() => useTimelinePlayback(s));
    act(() => result.current.togglePlay());
    expect(result.current.playing).toBe(true);
    act(() => result.current.setTimeMs(stepToMs(s, 3)));
    expect(result.current.playing).toBe(false);
    expect(result.current.timeMs).toBe(stepToMs(s, 3));
  });

  it('reduced motion uses the slower tick', () => {
    stubMatchMedia(true);
    const s = scale();
    const { result } = renderHook(() => useTimelinePlayback(s));
    act(() => result.current.togglePlay());
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.timeMs).toBe(s.minMs); // 150ms < 600ms tick
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.timeMs).toBe(stepToMs(s, 1));
  });
});
