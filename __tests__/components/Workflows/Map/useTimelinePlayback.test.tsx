import { act, renderHook } from '@testing-library/react';

import {
  DEFAULT_MAP_TIMELAPSE,
  keyframeDwellMs,
} from '@/lib/utils/shared/geo/timelapsePacing';
import {
  TimelineKeyframe,
  computeTimelineKeyframes,
} from '@/lib/utils/shared/geo/timelineKeyframes';
import {
  TimelineScale,
  computeTimelineScale,
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

/** A sparse historical mention plus a small burst of current events. */
const FEATURES = [
  feature({ id: 'h1', eventStart: '1812' }),
  feature({ id: 'e1', eventStart: '2026-05-01' }),
  feature({ id: 'e2', eventStart: '2026-05-10' }),
  feature({ id: 'e3', eventStart: '2026-05-20', eventOngoing: true }),
];

function fixtures(): { scale: TimelineScale; keyframes: TimelineKeyframe[] } {
  return {
    scale: computeTimelineScale(FEATURES, NOW) as TimelineScale,
    keyframes: computeTimelineKeyframes(FEATURES),
  };
}

/** Dwell of a keyframe that lands a single feature. */
const dwell = (reducedMotion = false) =>
  keyframeDwellMs({
    cardCount: 1,
    arrivalCount: 1,
    cardDurationMs: DEFAULT_MAP_TIMELAPSE.cardDurationMs,
    reducedMotion,
  });
const ONE_CARD_MS = dwell();

function stubMatchMedia(reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: reducedMotion,
  }) as unknown as typeof window.matchMedia;
}

describe('useTimelinePlayback (keyframe jumps)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts on the first keyframe and cues what arrives there', () => {
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.togglePlay());

    expect(result.current.timeMs).toBe(keyframes[0].ms);
    expect(result.current.cue).toMatchObject({
      index: 0,
      total: keyframes.length,
      spotlightIds: ['h1'],
    });
  });

  it('lingers on a date, then jumps straight to the next one', () => {
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.togglePlay());
    act(() => vi.advanceTimersByTime(ONE_CARD_MS - 1));
    // Still held on 1812 — the 214 empty years cost no ticks at all.
    expect(result.current.timeMs).toBe(keyframes[0].ms);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.timeMs).toBe(keyframes[1].ms);
    expect(result.current.cue?.keyframe.deltaMs).toBe(
      keyframes[1].ms - keyframes[0].ms,
    );
  });

  it('holds a busy date longer than a quiet one', () => {
    const crowded = [
      feature({ id: 'quiet', eventStart: '2026-05-01' }),
      ...Array.from({ length: 12 }, (_, i) =>
        feature({ id: `busy${i}`, eventStart: '2026-05-10' }),
      ),
    ];
    // Hoisted: the hook stops cleanly when the scale or keyframe identity
    // changes, so rebuilding them per render would cancel playback.
    const crowdedScale = computeTimelineScale(crowded, NOW) as TimelineScale;
    const crowdedKeyframes = computeTimelineKeyframes(crowded);
    const { result } = renderHook(() =>
      useTimelinePlayback(
        crowdedScale,
        crowdedKeyframes,
        DEFAULT_MAP_TIMELAPSE,
      ),
    );

    act(() => result.current.togglePlay());
    const quietDwell = result.current.cue?.dwellMs as number;

    act(() => vi.advanceTimersByTime(quietDwell));
    const busyDwell = result.current.cue?.dwellMs as number;

    expect(result.current.cue?.keyframe.enteringIds).toHaveLength(12);
    // Only 3 get cards, but the other 9 still buy the date more time.
    expect(result.current.cue?.spotlightIds).toHaveLength(3);
    expect(busyDwell).toBeGreaterThan(quietDwell);
  });

  it('applies a pacing change on the next date, without restarting', () => {
    const { scale, keyframes } = fixtures();
    const { result, rerender } = renderHook(
      ({ pacing }) => useTimelinePlayback(scale, keyframes, pacing),
      { initialProps: { pacing: DEFAULT_MAP_TIMELAPSE } },
    );

    act(() => result.current.togglePlay());
    expect(result.current.cue?.index).toBe(0);

    rerender({ pacing: { cardDurationMs: 5000, maxCardsPerDate: 1 } });
    // The keyframe already running keeps the duration it was budgeted for.
    expect(result.current.cue?.cardDurationMs).toBe(
      DEFAULT_MAP_TIMELAPSE.cardDurationMs,
    );
    expect(result.current.playing).toBe(true);

    act(() => vi.advanceTimersByTime(ONE_CARD_MS));
    expect(result.current.cue?.index).toBe(1);
    expect(result.current.cue?.cardDurationMs).toBe(5000);
  });

  it('stops on the final keyframe', () => {
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.togglePlay());
    act(() => vi.advanceTimersByTime(ONE_CARD_MS * (keyframes.length + 2)));

    expect(result.current.timeMs).toBe(keyframes[keyframes.length - 1].ms);
    expect(result.current.playing).toBe(false);
    expect(result.current.cue).toBeNull();
  });

  it('manual scrub pauses playback and clears the cue', () => {
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.togglePlay());
    expect(result.current.playing).toBe(true);

    act(() => result.current.setTimeMs(keyframes[2].ms));
    expect(result.current.playing).toBe(false);
    expect(result.current.cue).toBeNull();
    expect(result.current.timeMs).toBe(keyframes[2].ms);
  });

  it('resumes at the next keyframe after the scrubbed position', () => {
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.setTimeMs(keyframes[1].ms + 1));
    act(() => result.current.togglePlay());

    expect(result.current.cue?.index).toBe(2);
  });

  it('restarts from the beginning when played from the end', () => {
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.setTimeMs(keyframes[keyframes.length - 1].ms));
    act(() => result.current.togglePlay());

    expect(result.current.cue?.index).toBe(0);
  });

  it('reduced motion holds each date longer', () => {
    stubMatchMedia(true);
    const { scale, keyframes } = fixtures();
    const { result } = renderHook(() =>
      useTimelinePlayback(scale, keyframes, DEFAULT_MAP_TIMELAPSE),
    );

    act(() => result.current.togglePlay());
    act(() => vi.advanceTimersByTime(ONE_CARD_MS));
    expect(result.current.timeMs).toBe(keyframes[0].ms);

    act(() => vi.advanceTimersByTime(dwell(true) - ONE_CARD_MS));
    expect(result.current.timeMs).toBe(keyframes[1].ms);
  });
});
