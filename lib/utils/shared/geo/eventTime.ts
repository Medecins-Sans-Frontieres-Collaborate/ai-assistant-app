import {
  eventRangeEndsAt,
  eventRangeExtent,
  eventRangeFromLegacy,
  formatEventInstantLabel,
  parseEventInstant,
} from '@/lib/utils/shared/date/eventRange';

import { EventRange, MapFeature } from '@/types/workflow';

/**
 * Temporal interpretation of map features: the one place that decides what a
 * feature's timing IS, how it reads, and whether it is on screen at time T.
 * See docs/MAP_WORKFLOW.md ("Time lapse semantics").
 */

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * A feature's timing as a range, whichever shape it was stored in.
 *
 * THE read boundary for event timing — nothing downstream touches
 * `feature.event` or the legacy `eventStart`/`eventEnd`/`eventOngoing`
 * directly, so a map saved before ranges existed behaves identically to one
 * extracted today.
 */
export function featureEventRange(feature: MapFeature): EventRange | null {
  if (feature.event) return feature.event;
  return eventRangeFromLegacy(feature);
}

export function isDatedFeature(feature: MapFeature): boolean {
  return featureEventRange(feature) !== null;
}

/**
 * Human-readable date line for a feature, or null when undated. Rendered at
 * the material's own precision, so a bare "1812" never becomes "1 Jan 1812".
 * Keys are relative to the `workflows.map` namespace.
 */
export function formatFeatureDates(
  feature: MapFeature,
  locale: string,
  t: Translate,
): string | null {
  const range = featureEventRange(feature);
  if (!range) {
    // "Ongoing" with no date at all is undated for every purpose except
    // this line — the material told us the situation continues, which is
    // worth showing even though it pins nothing to the timeline.
    return feature.eventOngoing || feature.event?.ongoing
      ? t('dates.ongoing')
      : null;
  }

  const startMs = parseEventInstant(range.start);
  if (startMs === null) return null;
  const startLabel = formatEventInstantLabel(startMs, range.precision, locale);

  if (range.ongoing) return t('dates.since', { date: startLabel });

  const endMs = parseEventInstant(range.end);
  if (endMs === null) return startLabel;

  // The stored end is the first uncovered instant; label the last covered
  // one, so a March event reads "Mar 2026", not "Mar – Apr 2026".
  const endLabel = formatEventInstantLabel(endMs - 1, range.precision, locale);
  if (startLabel === endLabel) return startLabel;
  return t('dates.range', { start: startLabel, end: endLabel });
}

/* ------------------------------------------------------------------ */
/* Time-lapse visibility                                               */
/* ------------------------------------------------------------------ */

export type TemporalVerdict = 'active' | 'inactive' | 'undated';

/**
 * Hybrid semantics: a feature is active at time T once its start is reached
 * and until an explicitly stated end passes. Events with no stated end
 * persist after appearing — the material reported that they happened, not
 * that they stopped — and ongoing events persist by definition. Precision
 * widening (a "2026" event covers all of 2026) always favours visibility.
 */
export function featureVerdictAt(
  feature: MapFeature,
  tMs: number,
): TemporalVerdict {
  const range = featureEventRange(feature);
  if (!range) return 'undated';

  const startMs = parseEventInstant(range.start);
  if (startMs === null) return 'undated';
  if (startMs > tMs) return 'inactive';

  const endMs = eventRangeEndsAt(range);
  if (endMs !== null && endMs <= tMs) return 'inactive';
  return 'active';
}

/**
 * The instants a feature covers, for scale and range-filter maths. Wider
 * than visibility: an ongoing event covers through now, so it earns timeline
 * space for the whole span it has been running.
 */
export function featureCoverInterval(
  feature: MapFeature,
  nowMs: number = Date.now(),
): { startMs: number; endMs: number } | null {
  const range = featureEventRange(feature);
  if (!range) return null;
  return eventRangeExtent(range, nowMs);
}
