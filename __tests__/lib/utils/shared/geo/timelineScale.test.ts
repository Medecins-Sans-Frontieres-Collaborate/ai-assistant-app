import {
  TimelineScale,
  computeTimelineScale,
  msToStep,
  segmentAtStep,
  segmentLabel,
  stepToMs,
} from '@/lib/utils/shared/geo/timelineScale';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

function scaleOf(features: MapFeature[], nowMs?: number): TimelineScale {
  const scale = computeTimelineScale(features, nowMs);
  expect(scale).not.toBeNull();
  return scale as TimelineScale;
}

/* ------------------------------------------------------------------ */
/* Single-segment cases (ported linear behavior)                       */
/* ------------------------------------------------------------------ */

describe('computeTimelineScale — single-segment (linear) behavior', () => {
  it('is null with fewer than two dated features', () => {
    expect(
      computeTimelineScale([feature({ eventStart: '2026-01' }), feature()]),
    ).toBeNull();
  });

  it('spans the earliest to latest covered instant in one segment', () => {
    const scale = scaleOf([
      feature({ id: 'a', eventStart: '2026-01-10' }),
      feature({ id: 'b', eventStart: '2026-03', eventEnd: '2026-05' }),
    ]);
    expect(scale.segments).toHaveLength(1);
    expect(scale.minMs).toBe(Date.UTC(2026, 0, 10));
    expect(scale.maxMs).toBe(Date.UTC(2026, 5, 1) - 1);
    expect(scale.datedCount).toBe(2);
  });

  it('extends to now when any feature is ongoing', () => {
    const now = Date.UTC(2026, 6, 9);
    const scale = scaleOf(
      [
        feature({ id: 'a', eventStart: '2026-01-01' }),
        feature({ id: 'b', eventStart: '2026-02-01', eventOngoing: true }),
      ],
      now,
    );
    expect(scale.maxMs).toBe(now);
  });

  it('picks the step ladder from the segment span (dense segments)', () => {
    const days = scaleOf([
      feature({ id: 'a', eventStart: '2026-01-01' }),
      feature({ id: 'b', eventStart: '2026-01-15' }),
      feature({ id: 'c', eventStart: '2026-02-01' }),
    ]);
    expect(days.segments[0].stepMs).toBe(DAY_MS);

    // A range keeps the coverage connected across a >1y span.
    const weeks = scaleOf([
      feature({ id: 'a', eventStart: '2025-01-01', eventEnd: '2026-01-20' }),
      feature({ id: 'b', eventStart: '2025-06-01' }),
      feature({ id: 'c', eventStart: '2026-02-01' }),
    ]);
    expect(weeks.segments).toHaveLength(1);
    expect(weeks.segments[0].stepMs).toBe(WEEK_MS);
  });
});

/* ------------------------------------------------------------------ */
/* Clustering                                                          */
/* ------------------------------------------------------------------ */

/** Burst Mar 12 → Jun 10 (90d, day ladder) + three historical mentions. */
const NOW = Date.UTC(2026, 5, 10);
const earthquakeCase = (): MapFeature[] => [
  feature({ id: 'h1', eventStart: '1812' }),
  feature({ id: 'h2', eventStart: '1875' }),
  feature({ id: 'h3', eventStart: '1943' }),
  feature({ id: 'e1', eventStart: '2026-03-12' }),
  feature({ id: 'e2', eventStart: '2026-03-14', eventEnd: '2026-04-02' }),
  feature({ id: 'e3', eventStart: '2026-04-20' }),
  feature({ id: 'e4', eventStart: '2026-05-01', eventOngoing: true }),
];

describe('computeTimelineScale — clustering', () => {
  it('splits historical mentions from a dense current burst (4 eras)', () => {
    const scale = scaleOf(earthquakeCase(), NOW);
    expect(scale.segments).toHaveLength(4);

    // Sparse historical eras collapse to appear/end steps — a lone
    // "1812" mention must NOT get a year of weekly steps.
    for (const historical of scale.segments.slice(0, 3)) {
      expect(historical.stepCount).toBeLessThanOrEqual(2);
    }

    // The burst sweeps at day resolution and dominates the timeline.
    const burst = scale.segments[3];
    expect(burst.stepMs).toBe(DAY_MS);
    expect(burst.stepCount / scale.totalSteps).toBeGreaterThan(0.9);
    expect(scale.segments[0].startMs).toBe(Date.UTC(1812, 0, 1));
  });

  it('keeps a decade of yearly YEAR-precision reports as one era', () => {
    const features = Array.from({ length: 11 }, (_, i) =>
      feature({ id: `y${i}`, eventStart: String(2015 + i) }),
    );
    const scale = scaleOf(features, Date.UTC(2026, 0, 1));
    expect(scale.segments).toHaveLength(1);
  });

  it('keeps a decade of yearly DAY-precision reports as one era (fraction bar)', () => {
    const features = Array.from({ length: 10 }, (_, i) =>
      feature({ id: `d${i}`, eventStart: `${2016 + i}-06-15` }),
    );
    const scale = scaleOf(features, Date.UTC(2026, 0, 1));
    // 364d gaps are ~11% of the ~9y span — under the 20% fraction bar.
    expect(scale.segments).toHaveLength(1);
  });

  it('splits a burst from a mention 18 months prior (floor bar)', () => {
    const scale = scaleOf(
      [
        feature({ id: 'm', eventStart: '2024-11-01' }),
        feature({ id: 'a', eventStart: '2026-05-01' }),
        feature({ id: 'b', eventStart: '2026-05-20' }),
        feature({ id: 'c', eventStart: '2026-06-02' }),
      ],
      Date.UTC(2026, 6, 1),
    );
    expect(scale.segments).toHaveLength(2);
  });

  it('stays within the segment cap for many sparse eras', () => {
    // Exponentially growing gaps; only gaps >20% of the span split, so
    // at most 5 splits are mathematically possible — the cap is
    // defense-in-depth.
    const years = [1900, 1902, 1906, 1914, 1930, 1962, 2026];
    const features = years.map((y, i) =>
      feature({ id: `s${i}`, eventStart: `${y}-01-01` }),
    );
    const scale = scaleOf(features, Date.UTC(2026, 6, 1));
    expect(scale.segments.length).toBeLessThanOrEqual(8);
    expect(scale.segments.length).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ */
/* Step mapping                                                        */
/* ------------------------------------------------------------------ */

describe('step mapping', () => {
  const scale = scaleOf(earthquakeCase(), NOW);

  it('round-trips every step index and ends exactly at maxMs', () => {
    for (let i = 0; i < scale.totalSteps; i++) {
      expect(msToStep(scale, stepToMs(scale, i))).toBe(i);
    }
    expect(stepToMs(scale, scale.totalSteps - 1)).toBe(scale.maxMs);
    expect(stepToMs(scale, 0)).toBe(scale.minMs);
  });

  it('clamps outside the bounds', () => {
    expect(msToStep(scale, scale.minMs - DAY_MS)).toBe(0);
    expect(msToStep(scale, scale.maxMs + DAY_MS)).toBe(scale.totalSteps - 1);
    expect(stepToMs(scale, -5)).toBe(scale.minMs);
    expect(stepToMs(scale, scale.totalSteps + 5)).toBe(scale.maxMs);
  });

  it('snaps mid-gap times to the nearer era edge', () => {
    const first = scale.segments[0];
    const second = scale.segments[1];
    const nearFirst = first.endMs + DAY_MS;
    const nearSecond = second.startMs - DAY_MS;
    expect(msToStep(scale, nearFirst)).toBe(
      first.firstStepIndex + first.stepCount - 1,
    );
    expect(msToStep(scale, nearSecond)).toBe(second.firstStepIndex);
  });

  it('segmentAtStep resolves the owning segment', () => {
    const burst = scale.segments[3];
    expect(segmentAtStep(scale, burst.firstStepIndex)).toBe(burst);
    expect(segmentAtStep(scale, 0)).toBe(scale.segments[0]);
  });
});

describe('step cap', () => {
  it('coarsens dense segments uniformly to stay near the cap', () => {
    // 10 day-precision events every ~3 years: one dense era spanning
    // ~27y → monthly ladder ≈ 330 steps, over the 240 cap.
    const features = Array.from({ length: 10 }, (_, i) =>
      feature({ id: `c${i}`, eventStart: `${1999 + i * 3}-03-01` }),
    );
    const scale = scaleOf(features, Date.UTC(2026, 6, 1));
    expect(scale.segments).toHaveLength(1);
    expect(scale.totalSteps).toBeLessThanOrEqual(240 + scale.segments.length);
    // Coarsened in whole multiples of the ladder step.
    expect(scale.segments[0].stepMs % MONTH_MS).toBe(0);
    expect(scale.segments[0].stepMs).toBeGreaterThan(MONTH_MS);
  });
});

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

describe('segmentLabel', () => {
  const segment = (startMs: number, endMs: number) => ({
    startMs,
    endMs,
    stepMs: DAY_MS,
    stepCount: 1,
    firstStepIndex: 0,
  });

  it('labels a whole-year era with the year', () => {
    expect(
      segmentLabel(
        segment(Date.UTC(1812, 0, 1), Date.UTC(1813, 0, 1) - 1),
        'en',
      ),
    ).toBe('1812');
  });

  it('labels a multi-year era with the year range', () => {
    expect(
      segmentLabel(segment(Date.UTC(1990, 5, 1), Date.UTC(1998, 2, 1)), 'en'),
    ).toBe('1990–1998');
  });

  it('labels same-year month ranges and single months', () => {
    expect(
      segmentLabel(segment(Date.UTC(2026, 2, 12), Date.UTC(2026, 5, 15)), 'en'),
    ).toBe('Mar–Jun 2026');
    expect(
      segmentLabel(segment(Date.UTC(2026, 2, 2), Date.UTC(2026, 2, 28)), 'en'),
    ).toBe('Mar 2026');
  });
});
