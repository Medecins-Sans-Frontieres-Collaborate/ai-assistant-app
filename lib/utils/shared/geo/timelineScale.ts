import { featureCoverInterval } from '@/lib/utils/shared/geo/eventTime';

import { MapFeature } from '@/types/workflow';

/**
 * Adaptive piecewise time scale for the map time-lapse.
 *
 * Real materials mix a dense burst of current events with sparse
 * historical parallels ("similar earthquakes in 1812 and 1875…"). A
 * linear ms scale hands the slider and playback to empty centuries, so
 * instead the dated features are clustered into ERA SEGMENTS and the
 * timeline operates on uniform step indices: each segment gets its own
 * step size from its own span, dense eras get slider space proportional
 * to their step share, and crossing the gap between eras costs one tick.
 *
 * Clustering runs on COVERAGE INTERVALS, not raw boundary points —
 * precision widening makes consecutive year-precision dates adjacent
 * (1ms apart), so a decade of yearly reports stays one era for free.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

/** A gap splits eras only when it beats BOTH bars. */
const GAP_FLOOR_MS = 180 * DAY_MS;
const SPLIT_FRACTION = 0.2;
/** Strip renderability guard: only the largest gaps split. */
const MAX_SEGMENTS = 8;
/** Honors the playback pacing contract (~≤240 ticks per full sweep). */
const TOTAL_STEP_CAP = 240;

export interface TimelineSegment {
  startMs: number;
  endMs: number;
  /** Step size chosen from THIS segment's span (day/week/month ladder). */
  stepMs: number;
  stepCount: number;
  firstStepIndex: number;
}

export interface TimelineScale {
  /** Chronological, ≥1. A single segment ≡ the old linear behavior. */
  segments: TimelineSegment[];
  totalSteps: number;
  datedCount: number;
  minMs: number;
  maxMs: number;
}

interface CoverInterval {
  startMs: number;
  endMs: number;
}

/* ------------------------------------------------------------------ */
/* Date-range filtering                                                */
/* ------------------------------------------------------------------ */

/** Half-open bounds: null = unbounded on that side. */
export interface DateRange {
  fromMs: number | null;
  toMs: number | null;
}

export function isDateRangeActive(range: DateRange | null): boolean {
  return !!range && (range.fromMs !== null || range.toMs !== null);
}

/**
 * Does a feature belong to a date range? A dated feature matches when
 * its coverage interval (precision-widened; ongoing extends to now)
 * INTERSECTS the range — the same interval the timeline uses, so the
 * filter and the time-lapse always agree. Undated features are the
 * caller's policy decision (the workspace follows its "show undated"
 * toggle rather than silently dropping them).
 */
export function featureDateRangeVerdict(
  feature: MapFeature,
  range: DateRange,
  nowMs: number = Date.now(),
): 'in' | 'out' | 'undated' {
  const interval = featureCoverInterval(feature, nowMs);
  if (!interval) return 'undated';
  // The interval's end is EXCLUSIVE (a "2026" event ends at 2027-01-01T00:00),
  // so an event touching the bound exactly is out, not in — without the
  // `<=`, every year-precision event would leak into the next year.
  if (range.fromMs !== null && interval.endMs <= range.fromMs) return 'out';
  if (range.toMs !== null && interval.startMs > range.toMs) return 'out';
  return 'in';
}

function ladderStepMs(spanMs: number): number {
  return spanMs <= 92 * DAY_MS
    ? DAY_MS
    : spanMs <= 1100 * DAY_MS
      ? WEEK_MS
      : MONTH_MS;
}

/**
 * Timeline scale across the given features; null when fewer than two
 * dated features exist or the span is empty (control stays hidden).
 */
export function computeTimelineScale(
  features: MapFeature[],
  nowMs: number = Date.now(),
): TimelineScale | null {
  const intervals: CoverInterval[] = [];
  for (const feature of features) {
    const interval = featureCoverInterval(feature, nowMs);
    if (interval) intervals.push(interval);
  }
  if (intervals.length < 2) return null;

  intervals.sort((a, b) => a.startMs - b.startMs);
  const minMs = intervals[0].startMs;
  let maxMs = -Infinity;
  for (const interval of intervals) maxMs = Math.max(maxMs, interval.endMs);
  if (maxMs <= minMs) return null;

  // Merge overlapping/adjacent coverage into runs, recording the gaps.
  const runs: CoverInterval[] = [];
  const gaps: Array<{ afterRunIndex: number; gapMs: number }> = [];
  let current: CoverInterval = { ...intervals[0] };
  for (const interval of intervals.slice(1)) {
    if (interval.startMs <= current.endMs) {
      current.endMs = Math.max(current.endMs, interval.endMs);
      continue;
    }
    gaps.push({
      afterRunIndex: runs.length,
      gapMs: interval.startMs - current.endMs,
    });
    runs.push(current);
    current = { ...interval };
  }
  runs.push(current);

  // A gap splits eras when it beats the floor AND the span fraction;
  // cap the split count by keeping only the largest qualifying gaps.
  const threshold = Math.max(GAP_FLOOR_MS, SPLIT_FRACTION * (maxMs - minMs));
  const splitIndexes = new Set(
    gaps
      .filter((gap) => gap.gapMs > threshold)
      .sort((a, b) => b.gapMs - a.gapMs)
      .slice(0, MAX_SEGMENTS - 1)
      .map((gap) => gap.afterRunIndex),
  );

  const rawSegments: CoverInterval[] = [];
  let segment: CoverInterval = { ...runs[0] };
  runs.forEach((run, index) => {
    if (index === 0) return;
    if (splitIndexes.has(index - 1)) {
      rawSegments.push(segment);
      segment = { ...run };
    } else {
      segment.endMs = Math.max(segment.endMs, run.endMs);
    }
  });
  rawSegments.push(segment);

  // Distinct event boundaries (interval starts/ends) per segment: the
  // active set only ever changes at these instants, so a segment with
  // ≤3 of them is SPARSE — sweeping it on the calendar ladder would
  // hand dead steps to an era where nothing changes (a lone "1812"
  // mention widens to a 365-day interval; it must not get 54 weekly
  // steps). Sparse segments collapse to start/end.
  const boundaryCounts = rawSegments.map((raw) => {
    const boundaries = new Set<number>();
    for (const interval of intervals) {
      if (interval.startMs >= raw.startMs && interval.startMs <= raw.endMs) {
        boundaries.add(interval.startMs);
        boundaries.add(Math.min(interval.endMs, raw.endMs));
      }
    }
    return boundaries.size;
  });
  const SPARSE_BOUNDARY_MAX = 3;

  // Steps per segment from its own span; then a uniform coarsening pass
  // when the total exceeds the cap (uniformity preserves the relative
  // slider-space allocation, which is the point of the feature).
  const buildSegments = (factor: number): TimelineSegment[] => {
    const segments: TimelineSegment[] = [];
    let firstStepIndex = 0;
    rawSegments.forEach((raw, index) => {
      const span = raw.endMs - raw.startMs;
      const sparse = boundaryCounts[index] <= SPARSE_BOUNDARY_MAX;
      const stepMs = sparse ? Math.max(span, 1) : ladderStepMs(span) * factor;
      const stepCount = sparse
        ? span > 0
          ? 2
          : 1
        : Math.max(1, Math.ceil(span / stepMs) + 1);
      segments.push({
        startMs: raw.startMs,
        endMs: raw.endMs,
        stepMs,
        stepCount,
        firstStepIndex,
      });
      firstStepIndex += stepCount;
    });
    return segments;
  };

  let segments = buildSegments(1);
  let totalSteps = segments.reduce((sum, s) => sum + s.stepCount, 0);
  if (totalSteps > TOTAL_STEP_CAP) {
    segments = buildSegments(Math.ceil(totalSteps / TOTAL_STEP_CAP));
    totalSteps = segments.reduce((sum, s) => sum + s.stepCount, 0);
  }

  return { segments, totalSteps, datedCount: intervals.length, minMs, maxMs };
}

export function segmentAtStep(
  scale: TimelineScale,
  stepIndex: number,
): TimelineSegment {
  for (const segment of scale.segments) {
    if (stepIndex < segment.firstStepIndex + segment.stepCount) return segment;
  }
  return scale.segments[scale.segments.length - 1];
}

/** Time at a step index (clamped); the last step of a segment is its end. */
export function stepToMs(scale: TimelineScale, stepIndex: number): number {
  const clamped = Math.max(0, Math.min(scale.totalSteps - 1, stepIndex));
  const segment = segmentAtStep(scale, clamped);
  const k = clamped - segment.firstStepIndex;
  return Math.min(segment.startMs + k * segment.stepMs, segment.endMs);
}

/**
 * Nearest step index for a time: inside a segment, the nearest step;
 * inside a gap, the nearer segment edge; outside the bounds, clamped.
 */
export function msToStep(scale: TimelineScale, ms: number): number {
  const { segments } = scale;
  if (ms <= segments[0].startMs) return 0;
  const last = segments[segments.length - 1];
  if (ms >= last.endMs) return scale.totalSteps - 1;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (ms <= segment.endMs) {
      if (ms >= segment.startMs) {
        // Nearest actual step POSITION (the last one is clamped to
        // endMs, so a plain round() can miss it).
        const position = (k: number) =>
          Math.min(segment.startMs + k * segment.stepMs, segment.endMs);
        const k0 = Math.max(
          0,
          Math.min(
            Math.floor((ms - segment.startMs) / segment.stepMs),
            segment.stepCount - 1,
          ),
        );
        const k1 = Math.min(k0 + 1, segment.stepCount - 1);
        const k =
          Math.abs(ms - position(k1)) <= Math.abs(ms - position(k0)) ? k1 : k0;
        return segment.firstStepIndex + k;
      }
      // In the gap before this segment: snap to the nearer edge.
      const previous = segments[i - 1];
      const toPrevious = ms - previous.endMs;
      const toNext = segment.startMs - ms;
      return toPrevious <= toNext
        ? previous.firstStepIndex + previous.stepCount - 1
        : segment.firstStepIndex;
    }
  }
  return scale.totalSteps - 1;
}

/**
 * Compact era label for the segment strip: "1812", "1990–1998",
 * "Mar–Jun 2026", "Mar 2026". Raw Intl (UTC-pinned) like the control's
 * existing tick formatting — not i18n message content.
 */
/**
 * The last instant a segment actually covers. `endMs` is EXCLUSIVE, so
 * anything user-facing — era labels, the filter's inclusive `toMs`, the
 * timeline's end caption — has to step back off it, or a segment covering
 * 1812 reads as "1812–1813".
 */
export function segmentLastInstant(segment: TimelineSegment): number {
  return segment.endMs - 1;
}

export function segmentLabel(segment: TimelineSegment, locale: string): string {
  const start = new Date(segment.startMs);
  const end = new Date(segmentLastInstant(segment));
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  try {
    if (startYear !== endYear) return `${startYear}–${endYear}`;

    const monthFormat = new Intl.DateTimeFormat(locale, {
      month: 'short',
      timeZone: 'UTC',
    });
    const yearFormat = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      timeZone: 'UTC',
    });
    // Whole-year coverage (a year-precision era) reads as just the year.
    if (start.getUTCMonth() === 0 && end.getUTCMonth() === 11) {
      return yearFormat.format(segment.startMs);
    }
    if (start.getUTCMonth() === end.getUTCMonth()) {
      return `${monthFormat.format(segment.startMs)} ${yearFormat.format(segment.startMs)}`;
    }
    return `${monthFormat.format(segment.startMs)}–${monthFormat.format(segment.endMs)} ${yearFormat.format(segment.startMs)}`;
  } catch {
    return String(startYear);
  }
}
