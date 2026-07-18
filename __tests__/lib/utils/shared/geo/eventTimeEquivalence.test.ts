import { eventRangeFromLegacy } from '@/lib/utils/shared/date/eventRange';
import {
  featureCoverInterval,
  featureEventRange,
  featureVerdictAt,
  formatFeatureDates,
} from '@/lib/utils/shared/geo/eventTime';
import { computeTimelineKeyframes } from '@/lib/utils/shared/geo/timelineKeyframes';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

/**
 * The map's stored shape changed from partial ISO dates to explicit ranges.
 * Maps built before the change are not migrated — they are READ through the
 * same accessor — so the contract that matters is that a legacy feature and
 * its converted twin are indistinguishable everywhere downstream.
 */

const base = (over: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...over,
});

const LEGACY_SHAPES: Array<Partial<MapFeature>> = [
  { eventStart: '1812' },
  { eventStart: '2026-03' },
  { eventStart: '2026-03-12' },
  { eventStart: '2026-01', eventEnd: '2026-03' },
  { eventStart: '2026-03-01', eventEnd: '2026-03-01' },
  { eventStart: '2026-03', eventOngoing: true },
  { eventStart: '2026', eventEnd: '2026-06-15' },
];

const t = (key: string, values?: Record<string, string>) =>
  key === 'dates.range' ? `${values?.start} – ${values?.end}` : key;

describe('legacy features read identically to converted ones', () => {
  const probes = [
    Date.UTC(1811, 0, 1),
    Date.UTC(1812, 5, 1),
    Date.UTC(2025, 0, 1),
    Date.UTC(2026, 0, 15),
    Date.UTC(2026, 2, 12),
    Date.UTC(2026, 3, 1),
    Date.UTC(2026, 11, 31),
    Date.UTC(2030, 0, 1),
  ];
  const NOW = Date.UTC(2026, 5, 10);

  for (const shape of LEGACY_SHAPES) {
    const label = JSON.stringify(shape);

    it(`agrees on visibility, coverage, and display for ${label}`, () => {
      const legacy = base(shape);
      // The same feature as it would be stored today.
      const converted = base({
        event: eventRangeFromLegacy(shape) ?? undefined,
      });

      expect(featureEventRange(converted)).toEqual(featureEventRange(legacy));

      for (const tMs of probes) {
        expect(featureVerdictAt(converted, tMs)).toBe(
          featureVerdictAt(legacy, tMs),
        );
      }
      expect(featureCoverInterval(converted, NOW)).toEqual(
        featureCoverInterval(legacy, NOW),
      );
      expect(formatFeatureDates(converted, 'en', t)).toBe(
        formatFeatureDates(legacy, 'en', t),
      );

      const [a] = computeTimelineKeyframes([legacy]);
      const [b] = computeTimelineKeyframes([converted]);
      expect({ ...b, enteringIds: [] }).toEqual({ ...a, enteringIds: [] });
    });
  }

  it('reads the new shape in preference to stale legacy fields', () => {
    const feature = base({
      event: {
        start: '2026-03-12T14:30',
        end: null,
        precision: 'minute',
      },
      eventStart: '1812',
    });

    expect(featureEventRange(feature)?.precision).toBe('minute');
    expect(featureVerdictAt(feature, Date.UTC(1900, 0, 1))).toBe('inactive');
  });

  it('carries a time of day the old shape could not express', () => {
    const feature = base({
      event: { start: '2026-03-12T14:30', end: null, precision: 'minute' },
    });

    expect(featureVerdictAt(feature, Date.UTC(2026, 2, 12, 14, 29))).toBe(
      'inactive',
    );
    expect(featureVerdictAt(feature, Date.UTC(2026, 2, 12, 14, 30))).toBe(
      'active',
    );
    expect(formatFeatureDates(feature, 'en-GB', t)).toContain('14:30');
  });

  it('separates two events an hour apart on the same day', () => {
    const frames = computeTimelineKeyframes([
      base({
        id: 'morning',
        event: { start: '2026-03-12T09:00', end: null, precision: 'hour' },
      }),
      base({
        id: 'evening',
        event: { start: '2026-03-12T18:00', end: null, precision: 'hour' },
      }),
    ]);

    // Day-precision dates collapsed these into one moment; the timeline can
    // now stop on each.
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.enteringIds)).toEqual([
      ['morning'],
      ['evening'],
    ]);
  });
});
