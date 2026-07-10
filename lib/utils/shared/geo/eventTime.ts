import {
  formatPartialDate,
  parsePartialDate,
  partialDateEndMs,
  partialDateStartMs,
} from '@/lib/utils/shared/date/partialDate';

import { MapFeature } from '@/types/workflow';

/**
 * Temporal interpretation of map features: date display and the time-lapse
 * visibility model. See docs/MAP_WORKFLOW.md ("Time lapse semantics").
 */

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * Human-readable date line for a feature, or null when undated (legacy
 * features and features without material dates render no date line).
 * Keys are relative to the `workflows.map` namespace.
 */
export function formatFeatureDates(
  feature: MapFeature,
  locale: string,
  t: Translate,
): string | null {
  const start = parsePartialDate(feature.eventStart);
  const end = parsePartialDate(feature.eventEnd);

  if (!start && !end) {
    return feature.eventOngoing ? t('dates.ongoing') : null;
  }
  if (start && feature.eventOngoing) {
    return t('dates.since', { date: formatPartialDate(start, locale) });
  }
  if (start && end) {
    const startLabel = formatPartialDate(start, locale);
    const endLabel = formatPartialDate(end, locale);
    if (startLabel === endLabel) return startLabel;
    return t('dates.range', { start: startLabel, end: endLabel });
  }
  const single = (start ?? end) as NonNullable<typeof start>;
  return formatPartialDate(single, locale);
}

/* ------------------------------------------------------------------ */
/* Time-lapse visibility                                               */
/* ------------------------------------------------------------------ */

export type TemporalVerdict = 'active' | 'inactive' | 'undated';

/**
 * Hybrid semantics: a feature is active at time T when its start has been
 * reached AND it hasn't explicitly ended before T. Point events (no end)
 * persist after appearing; ranged events disappear when the material says
 * they ended; ongoing events persist. Precision widening (a "2026" date
 * covers the whole year) always favors visibility.
 */
export function featureVerdictAt(
  feature: MapFeature,
  tMs: number,
): TemporalVerdict {
  const start = parsePartialDate(feature.eventStart);
  const end = parsePartialDate(feature.eventEnd);
  if (!start && !end) return 'undated';

  if (start && partialDateStartMs(start) > tMs) return 'inactive';
  if (!feature.eventOngoing && end && partialDateEndMs(end) < tMs) {
    return 'inactive';
  }
  return 'active';
}

/*
 * Timeline bounds/steps moved to lib/utils/shared/geo/timelineScale.ts:
 * the linear range was replaced by an adaptive piecewise scale (era
 * segments) so dense event bursts aren't crushed by sparse historical
 * mentions. Visibility semantics (featureVerdictAt) live here unchanged.
 */
