import {
  coarserPrecision,
  eventRangeEndsAt,
  parseEventInstant,
} from '@/lib/utils/shared/date/eventRange';
import { featureEventRange } from '@/lib/utils/shared/geo/eventTime';

import {
  EventPrecision,
  MapFeature,
  MapFeatureProminence,
} from '@/types/workflow';

/**
 * Event keyframes for the map time-lapse.
 *
 * The piecewise scale in `timelineScale.ts` decides how the SLIDER is laid
 * out. This module answers a different question: which instants are worth
 * stopping on. Under `featureVerdictAt` the active set can only change when
 * a feature's range begins or its stated end passes, so every other step of
 * a linear sweep renders an identical map — playback that visits them all
 * spends most of its time showing nothing happening.
 *
 * Keyframes are exactly those change instants, so playback can jump between
 * them and linger, announcing how much time it skipped.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on a sweep's length. Each keyframe is held for a couple of
 * seconds, so an uncapped list (one dense source can produce hundreds) would
 * run for an hour. Beyond the cap the closest-together keyframes merge.
 */
const MAX_KEYFRAMES = 40;

const PROMINENCE_RANK: Record<MapFeatureProminence, number> = {
  primary: 0,
  secondary: 1,
  mention: 2,
};

export interface TimelineKeyframe {
  /** The instant the active set changes; what playback sets `timeMs` to. */
  ms: number;
  /**
   * The instant to DISPLAY, which is not always `ms`: an ending is stored
   * as the first uncovered instant, so it is labelled one ms earlier — a
   * March event ends in "Mar 2026", not "Apr 2026".
   */
  labelMs: number;
  /**
   * Precision to display `labelMs` at — the finest any contributing event
   * claimed, so a keyframe never renders more detail than its material had.
   */
  precision: EventPrecision;
  /**
   * The coarsest precision contributing here. When it differs from
   * `precision` the moment mixes exactly-timed and vaguely-timed events,
   * which the time-lapse marks visually.
   */
  coarsestPrecision: EventPrecision;
  /** Features that become active here, most prominent first. */
  enteringIds: string[];
  /** Features that stop being active here. */
  exitingIds: string[];
  /** Time skipped since the previous keyframe; 0 on the first. */
  deltaMs: number;
}

interface RawKeyframe {
  ms: number;
  labelMs: number;
  precision: EventPrecision;
  coarsestPrecision: EventPrecision;
  enteringIds: string[];
  exitingIds: string[];
  /** Prominence rank per id, for ordering after merges. */
  ranks: Map<string, number>;
}

function finerPrecision(a: EventPrecision, b: EventPrecision): EventPrecision {
  return coarserPrecision(a, b) === a ? b : a;
}

/**
 * Change instants across the given features, chronological.
 *
 * Mirrors `featureVerdictAt` exactly: a feature enters at its range start
 * and leaves at its stated end (the first uncovered instant). Events with no
 * stated end, and ongoing ones, never leave. Undated features are ignored;
 * they never change state.
 */
export function computeTimelineKeyframes(
  features: MapFeature[],
): TimelineKeyframe[] {
  const byMs = new Map<number, RawKeyframe>();

  const at = (
    ms: number,
    labelMs: number,
    precision: EventPrecision,
  ): RawKeyframe => {
    const existing = byMs.get(ms);
    if (existing) {
      existing.precision = finerPrecision(existing.precision, precision);
      existing.coarsestPrecision = coarserPrecision(
        existing.coarsestPrecision,
        precision,
      );
      return existing;
    }
    const created: RawKeyframe = {
      ms,
      labelMs,
      precision,
      coarsestPrecision: precision,
      enteringIds: [],
      exitingIds: [],
      ranks: new Map(),
    };
    byMs.set(ms, created);
    return created;
  };

  for (const feature of features) {
    const range = featureEventRange(feature);
    if (!range) continue;
    const startMs = parseEventInstant(range.start);
    if (startMs === null) continue;
    const rank = PROMINENCE_RANK[feature.prominence ?? 'primary'];

    const entry = at(startMs, startMs, range.precision);
    entry.enteringIds.push(feature.id);
    entry.ranks.set(feature.id, rank);

    const endMs = eventRangeEndsAt(range);
    // A range that ends at or before it starts never becomes visible; it
    // has no exit to announce.
    if (endMs !== null && endMs > startMs) {
      const exit = at(endMs, endMs - 1, range.precision);
      exit.exitingIds.push(feature.id);
      exit.ranks.set(feature.id, rank);
    }
  }

  const raw = [...byMs.values()].sort((a, b) => a.ms - b.ms);
  if (raw.length === 0) return [];

  return finalize(mergeToCap(raw));
}

/**
 * Collapse the closest-together keyframes until the list fits the cap.
 *
 * Merging by smallest gap keeps the jumps that carry meaning (the leap from
 * 1812 to 2026 survives; three reports in the same week become one stop).
 * A merged keyframe takes the LAST instant of its group, so the map state it
 * shows is the state after every transition in the group has happened.
 */
function mergeToCap(raw: RawKeyframe[]): RawKeyframe[] {
  if (raw.length <= MAX_KEYFRAMES) return raw;

  const gaps = raw
    .slice(1)
    .map((frame, index) => ({
      index: index + 1,
      gap: frame.ms - raw[index].ms,
    }))
    .sort((a, b) => a.gap - b.gap);
  // Merging one junction removes one keyframe.
  const merged = new Set(
    gaps.slice(0, raw.length - MAX_KEYFRAMES).map((entry) => entry.index),
  );

  const out: RawKeyframe[] = [];
  let group: RawKeyframe[] = [raw[0]];
  const flush = () => {
    const last = group[group.length - 1];
    const entering: string[] = [];
    const exiting: string[] = [];
    const ranks = new Map<string, number>();
    let precision = last.precision;
    let coarsest = last.coarsestPrecision;
    for (const frame of group) {
      entering.push(...frame.enteringIds);
      exiting.push(...frame.exitingIds);
      for (const [id, rank] of frame.ranks) ranks.set(id, rank);
      precision = finerPrecision(precision, frame.precision);
      coarsest = coarserPrecision(coarsest, frame.coarsestPrecision);
    }
    // A feature that both appears and vanishes inside the merged window is
    // never visible at the group's instant — it belongs to neither list.
    const flashed = new Set(entering.filter((id) => exiting.includes(id)));
    out.push({
      ms: last.ms,
      labelMs: last.labelMs,
      precision,
      coarsestPrecision: coarsest,
      enteringIds: entering.filter((id) => !flashed.has(id)),
      exitingIds: exiting.filter((id) => !flashed.has(id)),
      ranks,
    });
  };

  for (let i = 1; i < raw.length; i++) {
    if (merged.has(i)) {
      group.push(raw[i]);
      continue;
    }
    flush();
    group = [raw[i]];
  }
  flush();
  return out;
}

function finalize(raw: RawKeyframe[]): TimelineKeyframe[] {
  return raw.map((frame, index) => ({
    ms: frame.ms,
    labelMs: frame.labelMs,
    precision: frame.precision,
    coarsestPrecision: frame.coarsestPrecision,
    // Most prominent first: what the material is about leads the spotlight.
    enteringIds: [...frame.enteringIds].sort(
      (a, b) => (frame.ranks.get(a) ?? 0) - (frame.ranks.get(b) ?? 0),
    ),
    exitingIds: frame.exitingIds,
    deltaMs: index === 0 ? 0 : frame.ms - raw[index - 1].ms,
  }));
}

export interface JumpDelta {
  unit: 'years' | 'months' | 'days';
  count: number;
}

/**
 * The skipped interval as a single dominant unit ("3 years later"), or null
 * when the jump is under a day and there is nothing worth announcing.
 * One unit rather than a compound: it reads at a glance mid-animation, and
 * every locale can translate it.
 */
export function jumpDelta(deltaMs: number): JumpDelta | null {
  if (deltaMs < DAY_MS) return null;
  const days = Math.round(deltaMs / DAY_MS);
  if (days >= 365) return { unit: 'years', count: Math.round(days / 365) };
  if (days >= 45) return { unit: 'months', count: Math.round(days / 30) };
  return { unit: 'days', count: days };
}
