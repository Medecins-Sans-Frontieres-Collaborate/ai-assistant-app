import {
  parsePartialDate,
  partialDateEndMs,
} from '@/lib/utils/shared/date/partialDate';
import { featureVerdictAt } from '@/lib/utils/shared/geo/eventTime';
import {
  computeTimelineKeyframes,
  jumpDelta,
} from '@/lib/utils/shared/geo/timelineKeyframes';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;

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

describe('computeTimelineKeyframes', () => {
  it('emits one keyframe per change instant, chronologically', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'b', eventStart: '2026-05-10' }),
      feature({ id: 'a', eventStart: '2026-05-01' }),
    ]);

    expect(frames.map((f) => f.enteringIds)).toEqual([['a'], ['b']]);
    expect(frames[0].ms).toBe(Date.UTC(2026, 4, 1));
    expect(frames[1].ms).toBe(Date.UTC(2026, 4, 10));
  });

  it('ignores undated features', () => {
    expect(computeTimelineKeyframes([feature({ id: 'u' })])).toEqual([]);
  });

  it('groups features sharing an instant, most prominent first', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'aside', eventStart: '2026-05-01', prominence: 'mention' }),
      feature({ id: 'main', eventStart: '2026-05-01', prominence: 'primary' }),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].enteringIds).toEqual(['main', 'aside']);
  });

  it('exits one ms after the last covered instant, matching the verdict', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'a', eventStart: '2026-05-01', eventEnd: '2026-05-03' }),
    ]);
    expect(frames.map((f) => f.ms)).toEqual([
      Date.UTC(2026, 4, 1),
      // Exclusive end: the first instant no longer covered.
      Date.UTC(2026, 4, 4),
    ]);
    expect(frames[1].exitingIds).toEqual(['a']);
  });

  it('emits no exit for ongoing events', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'a', eventStart: '2026-05-01', eventOngoing: true }),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].exitingIds).toEqual([]);
  });

  it('emits no exit for a one-off event with no stated end', () => {
    // "It happened on 1 May" is not "it stopped on 2 May" — the marker
    // stays on the map once it appears.
    const frames = computeTimelineKeyframes([
      feature({ id: 'a', eventStart: '2026-05-01' }),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].exitingIds).toEqual([]);
  });

  it('a stated end outranks the ongoing flag', () => {
    // The same precedence `normalizeEventFields` applies server-side, so
    // inconsistent legacy data resolves the documented way.
    const frames = computeTimelineKeyframes([
      feature({
        id: 'a',
        eventStart: '2026-05-01',
        eventEnd: '2026-05-03',
        eventOngoing: true,
      }),
    ]);

    expect(frames).toHaveLength(2);
    expect(frames[1].exitingIds).toEqual(['a']);
  });

  it('keeps the source precision for display', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'old', eventStart: '1812' }),
      feature({ id: 'new', eventStart: '2026-05-01' }),
    ]);

    // "1812" must not render as Jan 1, 1812.
    expect(frames[0].precision).toBe('year');
    expect(frames[0].labelMs).toBe(Date.UTC(1812, 0, 1));
    expect(frames[1].precision).toBe('day');
  });

  it('labels an ending at its last covered instant, not the first after', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'a', eventStart: '2026-03-01', eventEnd: '2026-03' }),
    ]);

    // Stored exclusively as 1 April; a March event must still read "March".
    expect(frames[1].ms).toBe(Date.UTC(2026, 3, 1));
    expect(frames[1].labelMs).toBe(Date.UTC(2026, 3, 1) - 1);
    expect(frames[1].precision).toBe('month');
  });

  it('reports the finest and coarsest precision meeting at one instant', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'vague', eventStart: '2026' }),
      feature({ id: 'exact', eventStart: '2026-01-01' }),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].precision).toBe('day');
    expect(frames[0].coarsestPrecision).toBe('year');
  });

  it('reports the skipped interval between keyframes', () => {
    const frames = computeTimelineKeyframes([
      feature({ id: 'old', eventStart: '1812' }),
      feature({ id: 'new', eventStart: '2026-05-01' }),
    ]);

    expect(frames[0].deltaMs).toBe(0);
    expect(frames[1].deltaMs).toBe(frames[1].ms - frames[0].ms);
    expect(jumpDelta(frames[1].deltaMs)).toEqual({ unit: 'years', count: 214 });
  });

  it('the active set never changes between consecutive keyframes', () => {
    const features = [
      feature({ id: 'a', eventStart: '1812' }),
      feature({ id: 'b', eventStart: '2026-05-01', eventEnd: '2026-05-04' }),
      feature({ id: 'c', eventStart: '2026-05-03', eventOngoing: true }),
      feature({ id: 'd', eventEnd: '2026-06-01' }),
      feature({ id: 'e' }),
    ];
    const frames = computeTimelineKeyframes(features);

    const activeAt = (ms: number) =>
      features
        .filter((f) => featureVerdictAt(f, ms) === 'active')
        .map((f) => f.id)
        .join(',');

    for (let i = 0; i < frames.length - 1; i++) {
      const at = frames[i].ms;
      const justBeforeNext = frames[i + 1].ms - 1;
      expect(activeAt(justBeforeNext)).toBe(activeAt(at));
      // …and the next keyframe is a real change.
      expect(activeAt(frames[i + 1].ms)).not.toBe(activeAt(at));
    }
  });

  it('merges the closest keyframes to stay within the sweep cap', () => {
    // 100 consecutive days plus one distant historical mention.
    const features = [
      feature({ id: 'old', eventStart: '1900' }),
      ...Array.from({ length: 100 }, (_, i) =>
        feature({
          id: `d${i}`,
          eventStart: new Date(Date.UTC(2026, 0, 1 + i))
            .toISOString()
            .slice(0, 10),
        }),
      ),
    ];
    const frames = computeTimelineKeyframes(features);

    expect(frames.length).toBeLessThanOrEqual(40);
    // Every feature is still announced exactly once.
    const entering = frames.flatMap((f) => f.enteringIds);
    expect(new Set(entering).size).toBe(101);
    // The 126-year jump is preserved rather than merged away.
    expect(frames[0].enteringIds).toEqual(['old']);
    expect(jumpDelta(frames[1].deltaMs)?.unit).toBe('years');
  });
});

describe('jumpDelta', () => {
  it('says nothing about sub-day jumps', () => {
    expect(jumpDelta(0)).toBeNull();
    expect(jumpDelta(DAY_MS - 1)).toBeNull();
  });

  it('picks a single dominant unit', () => {
    expect(jumpDelta(3 * DAY_MS)).toEqual({ unit: 'days', count: 3 });
    expect(jumpDelta(44 * DAY_MS)).toEqual({ unit: 'days', count: 44 });
    expect(jumpDelta(60 * DAY_MS)).toEqual({ unit: 'months', count: 2 });
    expect(jumpDelta(730 * DAY_MS)).toEqual({ unit: 'years', count: 2 });
  });
});
